<img src="assets/quieasy-logo.png" alt="Quieasy logo: an indigo letter Q with a green check mark" width="96" height="96">

# Quieasy

Quieasy is a browser extension (Chrome and Arc) for multiple-choice practice where outside help is allowed, such as open-resource quizzes, practice tests, trivia games and sample-question pages. When you turn it on in a tab, it reads the questions on the page, looks up each answer with Claude and a web search, and shows a tiny faint gray dot on the likely correct choice **only while you hover it with your own mouse**. An answer key lists each answer with a short explanation and the web sources behind it.

> Only use Quieasy where outside resources are permitted. AI answers can be wrong, so check the sources before relying on one.

## What it does and doesn't do

- **You stay in control.** Quieasy never moves the mouse, clicks, selects, types or submits anything. You choose and submit every answer yourself.
- **Off by default.** It reads nothing until you turn it on, and it is off again after the browser restarts.
- **Nothing added to the page** apart from the hover dot. Progress and answers are in the toolbar popup.
- **Only the question is sent.** Question text and answer choices go to Anthropic. Cookies, passwords, page addresses and screenshots are not sent.

## Bring your own API key

Quieasy uses your own Anthropic API key, which you paste into its settings page. The key is stored only in your browser profile and sent only to `api.anthropic.com`. It is never part of the code or the build. Requests are billed to your own Anthropic account.

## Status

Quieasy is in early development and is not yet available from this repository or any extension store. The source code will be published here when it is ready.

Current limitations:

- It works only with Anthropic's Claude. Support for other AI providers is planned but not implemented.
- In Arc, the on and off keyboard shortcuts may not reach the extension. Use the toolbar popup's **On** and **Off** button instead.
- It has been tested with automated browser tests against sample pages, not yet against a live Canvas course.
