# Security

## Reporting a vulnerability

Please report security problems privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for them, and do not include a real API key in any report.

## What Quieasy protects

- **Your API keys.** Keys are kept in `chrome.storage.local`, which Quieasy restricts to its own extension pages and service worker. Content scripts and the web pages Quieasy runs on cannot read them. A key is sent only to the one endpoint of the service it belongs to, in that service's auth header, and never appears in request bodies, stored answers, error messages or logs. Quieasy has no server.
- **Your data.** Only the question wording, the answer choices and fixed instructions are sent, and only to the service you chose. Requests omit cookies and the referrer. There is no analytics or telemetry.
- **The page you are on.** Quieasy never clicks, selects, types or submits. It adds only two attributes to the choices it answered (`data-quieasy`, `data-quieasy-dot`) and one stylesheet for the hover dot. Text from the page and from the AI is always rendered as text, never as HTML, and only `http(s)` source links are shown.
- **Your AI bill.** Requests run only while Quieasy is on, at most 4 at a time. Each tab may start at most 200 lookups each time Quieasy is turned on, so a page that keeps rewriting its questions cannot run up unbounded charges. Turning Quieasy off cancels every request in progress.
- **Extension messages.** The service worker accepts messages only from Quieasy itself. Content scripts can only report the questions they found (length-checked and re-keyed in the service worker) and which answers they displayed; only Quieasy's own pages can turn it on or off, change settings or request the answer key.

## Known limitations

- **Prompt injection.** Question text comes from web pages and can contain instructions aimed at the AI. Quieasy tells the model to ignore them and keeps page text inside the question delimiters, but a page you turn Quieasy on in can still influence the answer, explanation and sources shown for its own questions. It cannot make Quieasy act on the page, reach other sites or read your key.
- **Detectable markers.** Scripts on a page can see the `data-quieasy` attributes and so tell that Quieasy is running and which choices it marked.
- **Shared answer cache.** Answers and the questions they belong to are kept in `chrome.storage.session` so the content scripts can show cached answers. Content scripts in any tab can read that store; web pages cannot.
- **Bedrock long-term keys.** A long-term Amazon Bedrock API key is a long-lived credential. Prefer short-term keys, as AWS recommends. Quieasy refuses AWS access keys and secret access keys outright.

## Supported versions

Only the latest version on the default branch receives fixes.
