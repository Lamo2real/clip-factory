// CloudFront Function (viewer request, cloudfront-js-2.0). App routes such as /jobs/01J... have no file
// extension: serve them index.html so the React router takes over. Real files (/assets/app.js, /config.json)
// pass through untouched, so a missing asset is still a 403/404 and never HTML.
// /downloads/* and /version.json have their own cache behaviours without this function; the prefix check below
// keeps a download path from ever turning into index.html even if a behaviour is reordered.
function handler(event) {
  var request = event.request;
  if (request.uri.indexOf("/downloads/") === 0) {
    return request;
  }
  var lastSegment = request.uri.substring(request.uri.lastIndexOf("/") + 1);
  if (lastSegment.indexOf(".") === -1) {
    request.uri = "/index.html";
  }
  return request;
}
