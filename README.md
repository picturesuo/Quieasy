<img src="assets/quieasy-logo.png" alt="Quieasy logo: an indigo letter Q with a green check mark" width="96" height="96">

# Quieasy

Quieasy is a Chrome/Arc extension for multiple-choice quizzes **where outside help is allowed**: open-book Canvas quizzes, practice tests, trivia games and sample-question pages. When you turn it on, it reads the quiz questions on the page, looks up each one with an AI model of your choice and a web search, and shows a tiny faint gray dot on the AI's answer **only while you hover that choice with your own mouse**. An answer key lists every answer with a short explanation and the web sources behind it.

Quieasy never moves the mouse, clicks, selects, types or submits anything. You answer the quiz yourself.

> [!IMPORTANT]
> Only use Quieasy where your instructor, school or the site allows outside resources. Using it on a closed-book exam or anywhere AI help is not permitted may break your school's academic integrity rules. AI answers can be wrong, so check the sources before relying on one.

Quieasy is early-stage software built by one person. It is tested against test pages modeled on real quiz layouts and against mock AI services, not yet against every real site or every AI account setup (see [What has not been verified](#what-has-not-been-verified)). It does not work on every page that has multiple-choice questions.

## Install

Requirements: Node.js 20 or newer, and Google Chrome 140 or newer (or Arc, which is built on Chrome).

```sh
git clone https://github.com/picturesuo/Quieasy.git
cd Quieasy
npm ci
npm run build
```

This creates the unpacked extension in `dist/` and a zip of it in `dist-zip/`.

- **Chrome:** open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose the `dist` folder.
- **Arc:** open `arc://extensions`, turn on **Developer mode**, click **Load unpacked** and choose the `dist` folder. Pin Quieasy from the extensions menu if you want to see its ON badge.

The extension card shows the version and the commit the build came from, for example `0.3.0 (1a2b3c4d5e6f)` (`-modified` means uncommitted changes were included).

To update, pull the new code, run `npm run build` again and click the reload button on Quieasy's card. Tabs that were already open drop their dots and stop; reload them to use Quieasy there again. Chrome names an unpacked extension after its folder, so always rebuild into the same folder you loaded: loading a different folder installs a separate copy with empty settings.

## Choose an AI service and add your own key

Quieasy has no server and no key of its own. You bring an API key for one of these services, and each question is billed to your account by that service. Open Quieasy's **Settings** (from the popup, or **Details → Extension options**), pick a service, fill in its fields and click **Save**.

| Service | What you need | Where requests go | Web search |
| --- | --- | --- | --- |
| **Anthropic Claude** | An Anthropic API key from [platform.claude.com](https://platform.claude.com/settings/keys) | `api.anthropic.com` | Anthropic's web search tool ($10 per 1,000 searches plus tokens). It must be enabled for your organization (it is by default). |
| **OpenAI API** | An OpenAI **API** key from [platform.openai.com](https://platform.openai.com/api-keys), billed per use. A ChatGPT subscription (Plus, Pro, Business) does not include API access and cannot be used. | `api.openai.com` | OpenAI's `web_search` tool in the Responses API, billed per search by OpenAI. |
| **Azure OpenAI** | Your Azure OpenAI or Microsoft Foundry resource endpoint (for example `https://your-resource.openai.azure.com`), the name of a model deployment in it, and one of the resource's API keys | your resource's own address, through the v1 Responses API | The Responses API `web_search` tool (Grounding with Bing, billed by Microsoft). Microsoft states that this data leaves your Azure compliance and geographic boundary. A subscription admin can turn web search off. |
| **Amazon Bedrock** | An **Amazon Bedrock API key** for `us-east-1`, `us-east-2` or `us-west-2`, and model access to OpenAI GPT-5.6 Sol, Terra or Luna | `bedrock-mantle.<region>.api.aws` | Bedrock Web Search. Quieasy sets `external_web_access: false`, so searches use Amazon's own index and page cache and stay inside AWS. The key's IAM identity needs `bedrock-mantle:CreateInference` and `bedrock-mantle:CallWithBearerToken` for the bedrock-mantle endpoint, and `bedrock-websearch:InvokeSearch` (plus `bedrock-websearch:InvokeFetch` for cached page content) for Web Search; see AWS's Web Search and API keys documentation. |

Notes:

- **Amazon Bedrock keys.** Use a short-term key (Bedrock console → **API keys** → **Short-term API keys**). It lasts at most 12 hours, works only in the Region it was created in, and must be pasted again after it expires. AWS recommends long-term Bedrock API keys only for trying Bedrock out; if you use one, give it a short expiry. Quieasy never asks for, and refuses, AWS access key IDs and secret access keys. Claude models on Bedrock are not offered because Bedrock does not provide web search for them.
- **Permissions.** For every service except Anthropic, Chrome asks you to allow Quieasy to reach that one address when you click Save. Nothing is saved if you decline.
- **Keys.** Each key is stored only in this browser profile (`chrome.storage.local`, which Quieasy restricts to its own pages and service worker; the pages Quieasy runs on cannot read it) and sent only to the address shown under the key field. Saved keys are never shown again, only their last four characters. **Remove key** deletes the key of the selected service; removing Quieasy from the browser deletes all of its settings and keys.
- **Upgrading from an earlier version** keeps a saved Anthropic key and model.

## Use

| Action | Default shortcut (macOS) |
| --- | --- |
| Turn Quieasy on (and read the current tab) | Option+Shift+Q |
| Turn Quieasy off | Option+Shift+O |
| Open the answer key | Option+Shift+K |

You can change these at `chrome://extensions/shortcuts` (Arc: `arc://extensions/shortcuts`). If a shortcut clashes with another app, Chrome leaves it unassigned; set one there.

- Quieasy is **off by default**, including after every browser restart. While it is off it reads nothing and sends nothing.
- When it is on, the toolbar badge shows **ON**. Nothing is added to the page itself; progress, answers and errors are in the answer key popup.
- Answers are fetched for every question on the page as soon as you turn Quieasy on, so they are usually ready before you reach them. Hovering never triggers a request.
- Hover a choice: the AI's answer shows a 3px faint dark gray dot, centered inside its radio button or checkbox, or just after the choice text when the page draws its own custom choices. The dot disappears when the pointer leaves. Other choices, and every choice of a question the AI is not sure about, stay unchanged.
- Turning Quieasy off removes every dot at once and cancels requests still in progress; late answers are discarded.
- If a question changes or you move to the next page, its dot is cleared immediately and the new question is looked up. An answer is only ever shown for the exact question text and choices it was found for.
- The answer key (toolbar icon or Option+Shift+K) lists each question, the answer, the AI's confidence, a short explanation, the sources it used, a **Try again** button for failed or unsure answers, and timings. **Open in a tab** keeps it open beside the quiz.
- To protect your AI bill, each tab starts at most 200 lookups each time you turn Quieasy on. The answer key says when a tab reaches that, and **Look up more** starts a new allowance.

### Where Quieasy runs

- **Canvas on `*.instructure.com`**: automatically on every page once Quieasy is on.
- **Any other site**: press the On shortcut (or click the toolbar icon and **On**) while that tab is in front. Chrome then lets Quieasy into that one tab (the `activeTab` permission), so Quieasy needs no standing access to the sites you visit. That access ends when the tab reloads or opens another page, so press the On shortcut again there.
- **Sites you use often, or your school's own Canvas address** (for example `canvas.yourschool.edu`): add them under **Settings → Sites Quieasy runs on automatically**, or, with Quieasy on, open the popup there and choose **Always allow on …**. Chrome asks you to confirm access to that one site, and Quieasy then runs on every page of it.

### Models

| Service | Models offered | Settings used |
| --- | --- | --- |
| Anthropic Claude | `claude-opus-5-5` (default), `claude-sonnet-5-5`, `claude-haiku-5-5` | low effort; up to 3 searches per question; server-side refusal fallback on Opus and Sonnet |
| OpenAI API | `gpt-6-astra` (default), `gpt-6.1-sol`, `gpt-6-luna` | low reasoning effort, low search context size |
| Azure OpenAI | your deployment | defaults of your deployment |
| Amazon Bedrock | `openai.gpt-5.6-sol` (default), `openai.gpt-5.6-terra`, `openai.gpt-5.6-luna` | low reasoning effort, low search context size |

Every request asks for a structured answer (choice letters, confidence, explanation, source URLs). Quieasy shows a dot only for a definite answer: high or medium confidence, exactly one choice for single-answer questions, and every chosen choice present on the page. Sources are kept only when the service's own search results or citations contain them; a URL the model wrote itself is never shown.

## Privacy

- Quieasy reads nothing until you turn it on. On Canvas it then reads only Classic Quizzes questions and New Quizzes items; other Canvas pages are not read. On other sites it reads only the tabs you turned it on in (and sites you allowed), and only parts that look like multiple-choice assessment questions. Settings, preferences, sign-in, newsletter, cookie, search, navigation, header and footer controls are skipped.
- For each question it sends the AI service you chose only the question wording, the answer choices, whether the question is single-answer or select-all, and fixed instructions. When a trivia question is only a bare prompt (for example "Alabama"), the page's main heading (for example "Which Is the US State Capital?") is sent with it. It does not send cookies, passwords, Canvas tokens, the page address, your name, course details, quiz instructions, other page content or screenshots. Requests carry no cookies or referrer.
- The AI service runs the web searches. Quieasy makes no other network requests: no analytics, telemetry or update checks.
- Requests to OpenAI, Azure OpenAI and Amazon Bedrock set `store: false`, asking the service not to keep the request and reply for later retrieval. Each service's own data-retention and abuse-monitoring terms still apply; check them for your account.
- Answers, the questions they belong to and timings are kept in browser memory (`chrome.storage.session`) and cleared when the browser restarts. Error messages are fixed text and never include the service's reply or your key.
- Quieasy marks the choices it answered with `data-quieasy` attributes so the hover dot can be drawn. Scripts on the page can see those attributes, and so can tell that Quieasy is running and which choices it marked.
- Classic Quizzes may log when you leave the quiz page; opening the answer key popup could count as leaving the page. Hovering does not.
- Permissions: `storage`; `scripting` (to run on Canvas, the sites you allow, and the tabs you turn Quieasy on in); `activeTab` (temporary access to the tab you turn Quieasy on in); access to `*.instructure.com` and `api.anthropic.com`; and optional access, granted one address at a time when you ask for it, to the extra sites you add and to the OpenAI, Azure or Bedrock address you save.

See [SECURITY.md](SECURITY.md) for the threat model and how to report a vulnerability.

## Supported quizzes

| Surface | Status |
| --- | --- |
| Canvas Classic Quizzes: multiple choice, true/false, multiple answers (select all) | Supported. Built and tested against markup taken from Canvas LMS's own templates (`app/views/quizzes/quizzes/_display_question.html.erb`, `_multi_answer.html.erb`). |
| Canvas New Quizzes: radio or checkbox questions | Best effort, **not verified on a real New Quizzes course**. Quieasy reads radio and checkbox groups only inside the New Quizzes frame (`*.quiz-lti-*.instructure.com`) or a New Quizzes question item, and is tested only on a hand-written page shaped like it. Forms on other Canvas pages (settings, notifications, discussions) are never read. |
| Other sites: radio and checkbox questions, including ARIA `role="radio"`/`role="checkbox"` widgets (for example Google Forms-style quizzes) | Supported when the group looks like an assessment question: the page title or main heading names a quiz, test, exam or similar, or the question itself reads like one (ends in "?", is numbered, or says "which of the following" / "select all") and does not address you as a preference ("How often should we email you?"). Tested on representative pages written for the tests. |
| Other sites: clickable answer boxes that are not form controls (trivia games such as Sporcle's multiple-choice games) | Supported on quiz/test pages: an element marked as the question (or a heading ending in "?") followed by a row of 2-10 boxes. Prev/next/submit buttons are never treated as answers. Tested on a page whose markup was modeled on the element ids and classes of Sporcle's public multiple-choice games. Only the question currently on screen exists in the page, so each next question is looked up when it appears. |
| Other sites: static lettered answer lists ("A. …", "(B) …", or `<ol type="A">`) after the question wording, as on published sample-question pages (for example NCBE's sample multiple-choice questions) | Supported on quiz/test/sample-question pages, when the wording reads like a question. "Select two" / "select all" makes it a multiple-answer question. Tested on a page whose markup was modeled on NCBE's public sample-question page. |
| Matching, dropdowns, fill in the blank, numeric, essay, file upload, hot spot, ordering | Not supported (ignored). |
| Questions drawn on a canvas, shown only as images, inside closed shadow DOM or cross-site frames, or built from widgets that expose no question/choice structure | Not supported. Quieasy cannot read them (or Chrome does not let it), so nothing is shown. Frames from the same site as the page are read. |

Quieasy needs the question and its choices to be readable text in the page with a recognizable structure, and it deliberately skips anything that might be an ordinary form, so it will miss some quizzes.

Canvas is phasing out Classic Quizzes (new ones cannot be created since May 2026), so most new courses use New Quizzes. Please report how Quieasy behaves on a real New Quizzes quiz.

## Limitations

- **AI answers are not guaranteed to be correct**, even with high confidence and sources. Unsure, failed, refused and ambiguous answers never get a dot.
- Images in questions or choices are not sent; the AI sees `[image]` in their place, the answer key flags these questions, and the answer may miss what the image shows. If several choices are only images, none of them gets a dot. Math written as Canvas equation images is sent as its LaTeX source.
- The AI decides whether to search. An answer the service gave without any web source says so in the answer key.
- Question text comes from web pages, which can try to instruct the AI. Quieasy tells the AI to ignore such instructions and keeps page text inside the question, but a page you turn Quieasy on in can still steer the answer it shows for that page's own questions.
- On other sites, Quieasy runs only in the tab you turned it on in and stops when that tab reloads or opens another page; press the On shortcut again, or allow the site in Settings.
- Speed: no figure is claimed. Each answer key entry shows where time went (**read page**, **queue** for one of 4 parallel request slots, **web search + AI**, **show**). Identical questions are looked up once: answers are cached by question text and choice set (in any order) until the browser restarts, shared across tabs, and reused after reloads, retakes and shuffled choices.

## Development

```sh
npm run typecheck   # TypeScript
npm run lint        # ESLint
npm test            # unit tests (Vitest)
npm run test:e2e    # builds, then runs the browser tests (Playwright)
npm run check       # all of the above
```

GitHub Actions runs `npm run check` on every pull request and push to `main` (`.github/workflows/ci.yml`).

Source layout:

| Path | What it does |
| --- | --- |
| `src/content/` | Content script: finds questions in the page (`extract.ts`) and sets the hover-dot markers (`markers.ts`, `content.css`). |
| `src/background/` | Service worker: on/off state, request scheduling and cancellation, site access. |
| `src/background/providers/` | One request builder and reply reader per API: Anthropic Messages (`anthropic.ts`) and the OpenAI Responses API used by OpenAI, Azure and Bedrock (`responses.ts`), the shared prompt (`prompt.ts`) and HTTP client (`http.ts`). |
| `src/shared/providers.ts` | The services, their settings, endpoints and input checks. |
| `src/popup/`, `src/options/` | The answer key popup and the settings page. |

The browser tests need Playwright's Chromium (`npx playwright install chromium`). They run headless in a throwaway profile, load a copy of the production `dist/` build, and point `*.instructure.com`, `*.example.com`, `api.anthropic.com`, `api.openai.com`, a test Azure resource and a Bedrock endpoint at a local HTTPS test server (`--host-resolver-rules`) that serves quiz pages and **mock** AI services. Every answer in the tests comes from those mocks and every key is synthetic; mock answers exist only in `tests/e2e/harness.ts`, and the extension has no demo or mock mode. The only changes to the copied build are extra host access to the test-only `*.example.com` sites (standing in for the access Chrome grants when you press the shortcut) and to the mock OpenAI, Azure and Bedrock addresses (standing in for confirming Chrome's prompt when saving settings). Set `QUIEASY_DIST` to run the tests against another build, and `QUIEASY_EVIDENCE_DIR` to save screenshots.

They cover, on other sites: nothing read until Quieasy is turned on in the tab; every question on the page (native radio and checkbox groups in several layouts, an ARIA custom radio widget, and a question in a same-site frame) read and sent at once before any hover; a dot only on the hovered answer; selection unchanged and only question content sent; off removing every dot; no on-page label or badge; questions added later; nothing read or sent on an ordinary settings page; a Sporcle-style trivia game, including the next question after NEXT; static lettered sample questions next to an ordinary lettered outline; Moodle-style and prompt-inside-options layouts sending only the question wording; an ordinary page reading a question about the US while skipping one that addresses the reader; the 200-lookup allowance per tab, including after Chrome stops the extension's service worker; turning Quieasy on with the popup's On button; hostile question text (HTML and prompt delimiters) kept as plain text in the request and the answer key; and Canvas still running without the extra step. On Canvas: off by default; hover-only faint dot, inside the native control or after a custom choice; no dot for wrong, unsure, failed or refused answers; the request containing only question content; the answer key with explanations and only real search-result sources; unchanged selection, focus, layout and form submission; immediate removal and discarded late answers when turned off; questions changed in place; cache reuse; shuffled choices; the missing-key notice; a New Quizzes style frame; nothing read or sent on a non-quiz Canvas page; separate on/off shortcuts being registered; an open quiz tab dropping its dots after the extension is reloaded; and turning Quieasy on again in a tab that was open before the reload. For each service: setting it up in the settings page, the exact endpoint, auth header and request body, the hover dot and answer key; a rejected key shown as a fixed message without the key or the service's reply; refusals; AWS access keys and bad Azure endpoints refused; removing a key; and an Anthropic key saved by an earlier version still working after an update. Unit tests cover the request bodies of every service, reply parsing, mocked HTTP failures, retries, cancellation, prompt delimiters that page text cannot close, and settings checks.

### What has not been verified

- Real AI requests: the tests use mock services built from each service's documentation, so real answer quality, latency and each service's acceptance of the exact request have not been measured with real keys. Please report problems with your service.
- Web search together with a strict JSON answer: to OpenAI, Azure OpenAI and Amazon Bedrock, Quieasy sends the `web_search` tool and a strict `json_schema` output format in the same Responses API request. Each service documents the two features separately; none documents the combination, and it has not been tried with a real key. If a service rejects it, every answer from that service fails with a fixed error and no dot is shown.
- Real Canvas: no live Canvas course or New Quizzes quiz was used.
- Pressing the shortcuts: headless Chromium cannot deliver browser-level extension shortcuts, so tests check the shortcuts are registered and drive the same on/off code path the shortcuts call. For the same reason Chrome's `activeTab` grant on a key press is not exercised.
- Live third-party sites: the Sporcle and NCBE layouts are covered only by test pages modeled on their markup.
- Arc: not run; Arc's extension and shortcut support is expected to match Chrome's.
- Chrome's permission prompts (adding a site, or saving an OpenAI, Azure or Bedrock endpoint) need a human click and were not automated.

## License

Quieasy is released under the MIT License. See [LICENSE](LICENSE).
