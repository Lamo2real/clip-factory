## CORS

The API allows only the app's CloudFront address and `http://localhost:5173` (local development), and exposes one
response header, `retry-after`, so the help panel can show its countdown. Media bucket CORS
allows `PUT` from the same origins for uploads.
