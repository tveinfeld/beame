const
  got = require('got'),
  kefir = require('kefir'),
  { pipeline } = require('stream'),
  { noop, always } = require('lodash/fp'),
  { ChunkStream } = require('./chunk_stream'),
  HttpAgent = require('agentkeepalive');

const
  MB = 1024 * 1024,
  CHUNK_SIZE = 4 * MB,
  HTTP_CLIENT_CONCURRENCY = 2,
  GA_API_VERSION = "6.0-preview";

module.exports = function({
  ga_api_base_url: gaApiBaseUrl,
  ga_api_token: gaApiToken,
  ga_run_id: gaRunId,
  artifact_name: artifactName,
  artifact_stream: artifactStream,
  http_concurrency = HTTP_CLIENT_CONCURRENCY,
  artifact_chunk_size = CHUNK_SIZE
}){
  
  const
    httpsAgent = new HttpAgent.HttpsAgent(),
    httpAgent = new HttpAgent();
  
  const artifactBaseUrl = `${gaApiBaseUrl}_apis/pipelines/workflows/${gaRunId}/artifacts`;
  const ghaStreamClient = (options)=>
    kefir
      .fromNodeCallback((cb)=> {
        got({
          agent: {
            https: httpsAgent,
            http: httpAgent
          },
          throwHttpErrors: true,
          ...options,
          headers: {
            "Accept": `application/json;api-version=${GA_API_VERSION}`,
            "Authorization": `Bearer ${gaApiToken}`,
            ...(options["headers"] || {})
          },
        }).then(cb.bind(null, null), cb);
      });
  
  return ghaStreamClient({
      resolveBodyOnly: true,
      responseType: "json",
      method: "POST",
      url: artifactBaseUrl,
      json: {
        Type: "actions_storage",
        Name: artifactName
      }
    })
    .flatMap(({ fileContainerResourceUrl: url })=>{
      let
        chunkId = 0,
        totalSize = 0;
  
      //const sourceStream = artifactStream;
      const sourceStream = pipeline(
        artifactStream,
        new ChunkStream({ chunk_size: artifact_chunk_size }),
        noop
      );
    
      return kefir
        .concat([
          kefir
            .fromEvents(sourceStream, 'data')
            .merge(kefir.fromEvents(sourceStream, 'error').flatMap(kefir.constantError))
            .takeUntilBy(kefir.fromEvents(sourceStream, 'end').take(1))
            .flatMapConcurLimit((chunk)=> {
              totalSize += chunk.length;
              return ghaStreamClient({
                resolveBodyOnly: true,
                responseType: "json",
                url,
                headers: {
                  "content-type": "application/octet-stream",
                  "content-length": chunk.length,
                  "content-range": `bytes 0-${chunk.length - 1}/${chunk.length}`,
                  "connection": "Keep-Alive",
                  "Keep-Alive": "10"
                },
                method: "PUT",
                searchParams: { "itemPath": `/${artifactName}/${ ["part", chunkId++].join('_') }.bin` },
                body: chunk
              }).map(always(chunkId));
            }, http_concurrency),
          ghaStreamClient({
            url: artifactBaseUrl,
            method: "PATCH",
            json: { Size: totalSize },
            searchParams: { "artifactName": artifactName },
            resolveBodyOnly: true,
            responseType: "json",
          }).map(always('Patched'))
        ]);
    })
    .spy()
    .beforeEnd(always(true))
    .takeErrors(1)
    .toPromise();
};

