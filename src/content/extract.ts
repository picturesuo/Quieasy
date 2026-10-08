import { MAX_CHOICE_CHARS, MAX_CHOICES, MAX_STEM_CHARS } from '../shared/settings';
import { normalizeText, questionKey, tidyText } from '../shared/text';
import type { QuestionData, QuestionKind, QuestionSource } from '../shared/types';

/** One question found on the page, with the elements a user hovers to pick each choice. */
export interface ExtractedQuestion {
  data: QuestionData;
  root: Element;
  /** Hover targets per choice, in the same order as data.choices. */
  targets: Element[][];
}

const MIN_STEM_LETTERS = 8;
/** Outside Canvas, longer "question" text means the stem search swallowed unrelated page text. */
const MAX_GENERIC_STEM_CHARS = 2000;

const SKIPPED_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'SELECT', 'INPUT', 'BUTTON', 'SVG', 'CANVAS', 'IFRAME',
]);
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER',
  'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LEGEND', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE',
  'SECTION', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'UL',
]);
const SCREEN_READER_ONLY_CLASSES = ['screenreader-only', 'sr-only', 'visually-hidden'];
const IMAGE_FILENAME = /\.(png|jpe?g|gif|svg|webp|bmp)$/i;

/** Page chrome that is not part of a question's wording. */
const GENERIC_LINES = [
  /^question\s*\d+(\s*of\s*\d+)?$/i,
  /^[\d.]+\s*\/?\s*[\d.]*\s*(pts?|points?)$/i,
  /^flag( this)? question$/i,
  /^(un)?answered$/i,
  /^(multiple choice|true\/false|true or false|multiple answers?):?$/i,
  /^(select|choose|pick|mark|check)\s+((only\s+)?one( or more)?|all that apply|[^:]{0,40}\b(answers?|options?|choices?))\s*:?$/i,
  /^(possible |answer |your )?(answers?|options?|choices?|responses?)\s*:?$/i,
  /^group of answer choices$/i,
];

const CHOICE_SELECTOR = 'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]';
const GROUP_SELECTOR = 'fieldset, [role="radiogroup"], [role="group"]';
const NEW_QUIZZES_ITEM = '[data-automation="sdk-take-item-question"]';
const NEW_QUIZZES_BODY = '[data-automation="sdk-item-body"]';

interface TextResult {
  text: string;
  hasImages: boolean;
}

interface ReadOptions {
  exclude?: (element: Element) => boolean;
  /** Stop before this node and everything after it in document order. */
  until?: Element;
}

/**
 * canvas: a Canvas page, where only Classic Quizzes and New Quizzes questions are read.
 * generic: any other site, where assessment-shaped questions are read (see extractGeneric).
 */
export type PageMode = 'canvas' | 'generic';

export function pageMode(doc: Document): PageMode {
  const host = doc.location?.hostname ?? '';
  if (host === 'instructure.com' || host.endsWith('.instructure.com')) return 'canvas';
  // Canvas on a school's own domain still renders its app shell.
  if (doc.querySelector('#application.ic-app, body.ic-app')) return 'canvas';
  return 'generic';
}

export function extractQuestions(doc: Document, mode: PageMode = pageMode(doc)): ExtractedQuestion[] {
  const claimed = new Set<Element>();
  const assessmentPage = mode === 'generic' && looksLikeAssessmentPage(doc);
  const found = [...extractClassic(doc, claimed), ...extractChoiceGroups(doc, claimed, mode, assessmentPage)];
  if (mode === 'generic') {
    found.push(...extractClickableChoices(doc, claimed, assessmentPage), ...extractLetteredLists(doc, claimed, assessmentPage));
  }
  return found;
}

/** Canvas Classic Quizzes, matching app/views/quizzes/quizzes/_display_question.html.erb and _multi_answer.html.erb. */
function extractClassic(doc: Document, claimed: Set<Element>): ExtractedQuestion[] {
  const found: ExtractedQuestion[] = [];
  for (const questionEl of Array.from(doc.querySelectorAll('.display_question'))) {
    if (questionEl.closest('#question_template') || questionEl.id === 'question_new') continue;
    if (!isVisible(questionEl)) continue;
    const answersEl = questionEl.querySelector('.answers');
    if (!answersEl) continue;
    const inputs = Array.from(answersEl.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]'));
    const kind = kindOf(inputs);
    if (!kind || inputs.length < 2 || inputs.length > MAX_CHOICES) continue;

    const options = inputs.map((input) => input.closest('.answer'));
    if (options.some((option) => !option) || new Set(options).size !== options.length) continue;
    const choiceResults = (options as Element[]).map((option) => readText(option.querySelector('.answer_label') ?? option));
    const stemEl = questionEl.querySelector('.question_text');
    if (!stemEl) continue;
    const stem = readText(stemEl);
    const label = readText(questionEl.querySelector('.question_name') ?? doc.createElement('span')).text;

    const question = buildQuestion({
      kind,
      stem,
      choices: choiceResults,
      label,
      source: 'canvas-classic',
    });
    if (!question) continue;
    inputs.forEach((input) => claimed.add(input));
    found.push({ data: question, root: questionEl, targets: (options as Element[]).map((option) => [option]) });
  }
  return found;
}

/**
 * Native radio/checkbox inputs or ARIA radio/checkbox widgets.
 *
 * On Canvas, only on a New Quizzes surface: inside a New Quizzes question item, or anywhere in
 * the New Quizzes (quiz-lti) frame. New Quizzes is an Instructure UI app whose markup Quieasy has
 * not been able to verify against a live course, so this is best effort. Forms on other Canvas
 * pages are never read. On other sites, a group is read only when it looks like an assessment
 * question rather than a setting, preference or navigation control (see isAssessmentQuestion).
 */
function extractChoiceGroups(
  doc: Document,
  claimed: Set<Element>,
  mode: PageMode,
  assessmentPage: boolean,
): ExtractedQuestion[] {
  const newQuizzesFrame = mode === 'canvas' && Boolean(doc.location?.hostname.includes('quiz-lti'));
  const groups = new Map<unknown, Element[]>();
  for (const element of Array.from(doc.querySelectorAll(CHOICE_SELECTOR))) {
    if (claimed.has(element)) continue;
    if (element instanceof HTMLInputElement && element.parentElement?.closest('[role="radio"], [role="checkbox"]')) continue;
    const groupKey = choiceGroupKey(element, mode);
    if (groupKey === null) continue;
    const members = groups.get(groupKey);
    if (members) members.push(element);
    else groups.set(groupKey, [element]);
  }

  const found: ExtractedQuestion[] = [];
  for (const members of groups.values()) {
    const kind = kindOf(members);
    if (!kind || members.length < 2 || members.length > MAX_CHOICES) continue;
    const container = groupContainer(members);
    if (!container || !isVisible(container)) continue;
    const newQuizzes = newQuizzesFrame || Boolean(container.closest(NEW_QUIZZES_ITEM));
    if (mode === 'canvas' && !newQuizzes) continue;
    if (!newQuizzes && isExcludedContext(container)) continue;

    const targets = members.map((member) => hoverTargets(member, container, members));
    const choices = members.map((member, index) => choiceText(member, targets[index] as Element[]));
    const firstChoice = targets.flat().reduce((first, target) => (first.compareDocumentPosition(target) & 2 ? target : first));
    const stemResult = findStem(container, members, firstChoice, !newQuizzes);
    if (!stemResult) continue;
    if (!newQuizzes && !isAssessmentQuestion(stemResult.stem.text, choices.map((choice) => choice.text), assessmentPage)) continue;

    const question = buildQuestion({
      kind,
      stem: stemResult.stem,
      choices,
      label: stemResult.label,
      source: newQuizzes ? 'canvas-new-quizzes' : 'generic',
    });
    if (!question) continue;
    members.forEach((member) => claimed.add(member));
    found.push({ data: question, root: stemResult.root, targets });
  }
  return found;
}

function buildQuestion(parts: {
  kind: QuestionKind;
  stem: TextResult;
  choices: TextResult[];
  label: string;
  source: QuestionSource;
}): QuestionData | null {
  const stem = parts.stem.text.slice(0, MAX_STEM_CHARS);
  const choices = parts.choices.map((choice) => choice.text.slice(0, MAX_CHOICE_CHARS));
  if (!stem || choices.some((choice) => choice.length === 0)) return null;
  return {
    key: questionKey(parts.kind, stem, choices),
    kind: parts.kind,
    stem,
    choices,
    hasImages: parts.stem.hasImages || parts.choices.some((choice) => choice.hasImages),
    label: parts.label,
    source: parts.source,
  };
}

function kindOf(elements: Element[]): QuestionKind | null {
  const kinds = new Set(
    elements.map((element) => {
      if (element instanceof HTMLInputElement) return element.type === 'radio' ? 'single' : 'multiple';
      return element.getAttribute('role') === 'radio' ? 'single' : 'multiple';
    }),
  );
  return kinds.size === 1 ? (kinds.values().next().value as QuestionKind) : null;
}

function choiceGroupKey(element: Element, mode: PageMode): unknown {
  if (element instanceof HTMLInputElement && element.type === 'radio' && element.name) {
    return `radio:${element.form ? formIndex(element.form) : -1}:${element.name}`;
  }
  const declared = element.closest(`${GROUP_SELECTOR}, ${NEW_QUIZZES_ITEM}`);
  if (declared || mode === 'canvas') return declared;
  // Outside Canvas, checkboxes of one question often share a name such as "q2[]" with no group element.
  if (element instanceof HTMLInputElement && element.type === 'checkbox' && element.name) {
    return `checkbox:${element.form ? formIndex(element.form) : -1}:${element.name.replace(/\[\]$/, '')}`;
  }
  return null;
}

const formIndexes = new WeakMap<HTMLFormElement, number>();
function formIndex(form: HTMLFormElement): number {
  let index = formIndexes.get(form);
  if (index === undefined) {
    index = Array.from(form.ownerDocument.forms).indexOf(form);
    formIndexes.set(form, index);
  }
  return index;
}

/** The smallest element that contains every choice of the group. */
function groupContainer(members: Element[]): Element | null {
  const first = members[0];
  if (!first) return null;
  const declared = first.closest(GROUP_SELECTOR);
  if (declared && members.every((member) => declared.contains(member))) return declared;
  for (let node = first.parentElement; node; node = node.parentElement) {
    if (members.every((member) => node.contains(member))) return node;
  }
  return null;
}

/** The largest element around one choice that contains no other choice of the same group. */
function hoverTargets(member: Element, container: Element, members: Element[]): Element[] {
  let node: Element = member;
  while (node.parentElement && node.parentElement !== container) {
    const parent: Element = node.parentElement;
    if (members.some((other) => other !== member && parent.contains(other))) break;
    node = parent;
  }
  if (node === member && member instanceof HTMLInputElement && member.labels) {
    return [member, ...Array.from(member.labels).filter((label) => !label.contains(member))];
  }
  return [node];
}

function choiceText(member: Element, targets: Element[]): TextResult {
  if (member instanceof HTMLInputElement && member.labels && member.labels.length > 0) {
    const parts = Array.from(member.labels).map((label) => readText(label));
    const joined = joinResults(parts);
    if (joined.text) return joined;
  }
  const labelledBy = textFromIds(member, 'aria-labelledby');
  if (labelledBy?.text) return labelledBy;
  const ariaLabel = member.getAttribute('aria-label')?.trim();
  if (ariaLabel) return { text: ariaLabel, hasImages: false };
  const fromTargets = joinResults(targets.map((target) => readText(target)));
  if (fromTargets.text || !(member instanceof HTMLInputElement)) return fromTargets;
  return trailingText(member);
}

/** Wording after a bare input, as in "<input type=radio> Mercury<br>", up to the next line or choice. */
function trailingText(member: Element): TextResult {
  const parts: TextResult[] = [];
  for (let node = member.nextSibling; node; node = node.nextSibling) {
    if (node.nodeType === 3) parts.push({ text: node.nodeValue ?? '', hasImages: false });
    if (node.nodeType !== 1) continue;
    const element = node as Element;
    const tag = element.tagName;
    if (tag === 'BR' || BLOCK_TAGS.has(tag) || SKIPPED_TAGS.has(tag) || element.matches(CHOICE_SELECTOR) || element.querySelector(CHOICE_SELECTOR)) break;
    parts.push(readText(element));
  }
  return joinResults(parts);
}

interface StemResult {
  stem: TextResult;
  root: Element;
  label: string;
}

/**
 * The nearest wording wins: a New Quizzes item body or aria-labelledby, then the text before the
 * choices in their own container (a fieldset legend included), then each enclosing level, then
 * the previous sibling. Prompt lines such as "Select one:" or "Possible answers" are page chrome
 * (GENERIC_LINES) and never count as wording, so the search moves past them to the question.
 */
function findStem(container: Element, members: Element[], firstChoice: Element, generic: boolean): StemResult | null {
  const result = findStemText(container, members, firstChoice, generic);
  if (generic && result && result.stem.text.length > MAX_GENERIC_STEM_CHARS) return null;
  return result;
}

function findStemText(container: Element, members: Element[], firstChoice: Element, generic: boolean): StemResult | null {
  const memberSet = new Set(members);
  const item = container.closest(NEW_QUIZZES_ITEM);
  if (item) {
    const body = item.querySelector(NEW_QUIZZES_BODY);
    if (body && !members.some((member) => body.contains(member))) {
      const stem = cleanStem(readText(body));
      if (stem) return { stem, root: item, label: questionLabel(item) };
    }
  }

  const labelledBy = textFromIds(container, 'aria-labelledby');
  if (labelledBy) {
    const stem = cleanStem(labelledBy);
    if (stem) return { stem, root: container, label: questionLabel(container) };
  }

  const own = cleanStem(readText(container, { until: firstChoice }));
  if (own) return { stem: own, root: container, label: questionLabel(container) };

  let node: Element = container;
  for (; node.parentElement; node = node.parentElement) {
    const parent: Element = node.parentElement;
    if (parent === parent.ownerDocument.documentElement) break;
    const otherChoice = Array.from(parent.querySelectorAll(CHOICE_SELECTOR)).some((element) => !memberSet.has(element));
    if (otherChoice) break;
    if (generic && parent.tagName === 'BODY') break;
    const stem = cleanStem(readText(parent, { exclude: (element) => element === container }));
    if (stem) return { stem, root: parent, label: questionLabel(parent) };
  }
  if (!generic) return null;
  // Questions laid out as siblings, such as <h3>question</h3><ul>choices</ul> inside one form.
  const previous = node.previousElementSibling;
  if (!previous || previous.matches(CHOICE_SELECTOR) || previous.querySelector(CHOICE_SELECTOR)) return null;
  const stem = cleanStem(readText(previous));
  return stem ? { stem, root: node, label: questionLabel(previous) } : null;
}

/** Drops page chrome lines; returns null unless real question wording remains. */
function cleanStem(result: TextResult): TextResult | null {
  const lines = result.text.split('\n').filter((line) => !GENERIC_LINES.some((pattern) => pattern.test(line)));
  const text = lines.join('\n');
  const letters = text.replace(/[^\p{L}\p{N}]/gu, '').length;
  if (letters < MIN_STEM_LETTERS && !result.hasImages) return null;
  if (!text) return null;
  return { text, hasImages: result.hasImages };
}

function questionLabel(root: Element): string {
  const line = readText(root).text.split('\n').find((candidate) => /^question\s*\d+/i.test(candidate));
  return line ?? '';
}

function textFromIds(element: Element, attribute: string): TextResult | null {
  const ids = element.getAttribute(attribute)?.split(/\s+/).filter(Boolean) ?? [];
  if (ids.length === 0) return null;
  const doc = element.ownerDocument;
  const parts = ids.flatMap((id) => {
    const target = doc.getElementById(id);
    return target ? [readText(target)] : [];
  });
  return parts.length ? joinResults(parts) : null;
}

function joinResults(parts: TextResult[]): TextResult {
  return {
    text: tidyText(parts.map((part) => part.text).join('\n')),
    hasImages: parts.some((part) => part.hasImages),
  };
}

/** Visible text of an element, with image alt text and equation sources inline. */
export function readText(root: Element, options: ReadOptions = {}): TextResult {
  const chunks: string[] = [];
  let hasImages = false;

  const visit = (node: Node): void => {
    if (node !== root && options.until && (node === options.until || options.until.compareDocumentPosition(node) & 4)) return;
    if (node.nodeType === 3) {
      chunks.push(node.nodeValue ?? '');
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (element !== root && options.exclude?.(element)) return;
    const tag = element.tagName.toUpperCase();
    if ((element !== root && SKIPPED_TAGS.has(tag)) || isHiddenForText(element)) return;
    if (tag === 'BR') {
      chunks.push('\n');
      return;
    }
    if (tag === 'IMG') {
      const equation = element.getAttribute('data-equation-content')?.trim();
      const alt = element.getAttribute('alt')?.trim();
      if (equation) chunks.push(` ${equation} `);
      else if (alt && !IMAGE_FILENAME.test(alt)) chunks.push(` [image: ${alt}] `);
      else {
        chunks.push(' [image] ');
        hasImages = true;
      }
      return;
    }
    const block = BLOCK_TAGS.has(tag);
    if (block) chunks.push('\n');
    element.childNodes.forEach(visit);
    if (block) chunks.push('\n');
  };

  visit(root);
  return { text: tidyText(chunks.join('')), hasImages };
}

function isHiddenForText(element: Element): boolean {
  if (element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true') return true;
  if (SCREEN_READER_ONLY_CLASSES.some((name) => element.classList.contains(name))) return true;
  const style = (element as HTMLElement).style;
  return style?.display === 'none' || style?.visibility === 'hidden';
}

function isVisible(element: Element): boolean {
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (node.hasAttribute('hidden')) return false;
    const style = (node as HTMLElement).style;
    if (style?.display === 'none') return false;
  }
  if (typeof element.checkVisibility === 'function' && !element.checkVisibility()) {
    const view = element.ownerDocument.defaultView;
    return view?.getComputedStyle(element).display === 'contents';
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Other sites. Quieasy reads a question only when its structure is clearly a multiple-choice
// assessment item, never ordinary settings, preferences, navigation or marketing controls.

const ASSESSMENT_PAGE =
  /\b(quiz(zes)?|tests?|exams?|assessments?|questionnaire|worksheet|trivia|homework|midterm|final exam|(practice|sample|review|test|exam) (questions|problems|set)|knowledge check|check your understanding|multiple[- ]choice|mcqs?)\b/i;
const NOT_ASSESSMENT_PAGE = /\b(settings|preferences|my account|account|checkout|sign in|log in|sign up)\b/i;
const QUESTION_LIKE =
  /\?\s*$|^\s*(\d+[.)]\s|q\d+[.):]|question\s*\d+)|_{3,}|\b(which of the following|which of these|true or false|(select|choose|pick) (one|two|three|all|the (best|correct|right))|all that apply)\b/im;
/** Second-person or first-person wording that marks a preference or survey item on an ordinary page. */
const ADDRESSES_USER = /\b(you|your|yours|we|our|my|me)\b/i;
/** Lowercase "us" is personal wording; "US" is the country. */
const PERSONAL_US = /\b[Uu]s\b/;
const PREFERENCE_STEM =
  /\b(e-?mail (me|you)|notify me|notifications?|newsletter|(un)?subscribe|cookies|remember me|keep me (signed|logged) in|sign me up|your (account|profile|settings|preferences))\b/i;
const SETTING_CHOICE =
  /^(on|off|yes|no|enabled?|disabled?|show|hide|light|dark|system|system default|auto|automatic|never|always|daily|weekly|monthly|immediately|none|all|default)$/i;
const EXCLUDED_TAGS = new Set(['NAV', 'HEADER', 'FOOTER', 'MENU']);
const EXCLUDED_ROLES = new Set(['navigation', 'menu', 'menubar', 'toolbar', 'tablist', 'tree', 'banner', 'contentinfo', 'search']);
const EXCLUDED_TOKENS = new Set([
  'settings', 'setting', 'preferences', 'preference', 'prefs', 'notification', 'notifications', 'account', 'profile',
  'privacy', 'cookie', 'cookies', 'consent', 'gdpr', 'newsletter', 'subscribe', 'subscription', 'signup', 'signin',
  'login', 'register', 'registration', 'checkout', 'cart', 'shipping', 'billing', 'payment', 'search', 'filter',
  'filters', 'sort', 'poll', 'survey', 'feedback', 'rating', 'ratings',
]);
const CHOICE_HINT = /answer|choice|option|alternative/i;
const STEM_HINT = /question|prompt/i;
const CONTROL_TEXT =
  /^(prev(ious)?|next|back|skip|submit|continue|start|play|play again|give up|finish|done|check|hint|reset|restart|retry|close|cancel|ok|save|menu|more|share|report)$/i;
const MAX_BOX_CHOICES = 10;
const MAX_BOX_CHOICE_CHARS = 300;
const MAX_SCOPE_ELEMENTS = 4000;
const LETTER_MARKER = /^\(?([A-J])[.):]\s+/;
const MULTI_SELECT = /\b(select|choose|pick|mark) (two|three|four|all|\d+)\b|\ball that apply\b|\bmore than one\b/i;

/** The page title or main headings name a quiz, test, exam or similar. */
export function looksLikeAssessmentPage(doc: Document): boolean {
  const headings = Array.from(doc.querySelectorAll('h1, h2')).slice(0, 10).map((heading) => heading.textContent ?? '');
  const title = doc.title ?? '';
  const text = [title, ...headings].join('\n');
  return ASSESSMENT_PAGE.test(text) && !NOT_ASSESSMENT_PAGE.test(title);
}

/** Inside navigation, a page header or footer, a toolbar, or a settings/account/marketing form. */
export function isExcludedContext(element: Element | null): boolean {
  for (let node = element; node && node.tagName !== 'BODY' && node.tagName !== 'HTML'; node = node.parentElement) {
    if (EXCLUDED_TAGS.has(node.tagName)) return true;
    if (EXCLUDED_ROLES.has(node.getAttribute('role') ?? '')) return true;
    const names = ['id', 'name', 'aria-label', 'action', 'class'].map((attribute) => node.getAttribute(attribute) ?? '');
    if (names.some((value) => tokens(value).some((token) => EXCLUDED_TOKENS.has(token)))) return true;
  }
  return false;
}

function tokens(value: string): string[] {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Whether a choice group outside Canvas reads as an assessment question rather than a preference. */
export function isAssessmentQuestion(stem: string, choices: string[], assessmentPage: boolean): boolean {
  if (PREFERENCE_STEM.test(stem)) return false;
  if (assessmentPage) return true;
  if (choices.every((choice) => SETTING_CHOICE.test(choice.trim()))) return false;
  return QUESTION_LIKE.test(stem) && !ADDRESSES_USER.test(stem) && !PERSONAL_US.test(stem);
}

/**
 * Answer boxes and lettered lists are not form controls, so they are weaker evidence than a
 * radio group: they count only on a quiz/test/exam page and with question-like wording.
 */
function isLooseAssessmentQuestion(stem: string, assessmentPage: boolean): boolean {
  return assessmentPage && QUESTION_LIKE.test(stem) && !PREFERENCE_STEM.test(stem);
}

/**
 * Clickable answer boxes that are not form controls, as on trivia sites: a question element
 * (marked "question" or "prompt", or a heading or paragraph ending in "?") followed by a row of
 * 2-10 sibling boxes of one kind that look clickable or are marked as answers/choices/options.
 */
function extractClickableChoices(doc: Document, claimed: Set<Element>, assessmentPage: boolean): ExtractedQuestion[] {
  const found: ExtractedQuestion[] = [];
  const usedGroups = new Set<Element>();
  for (const stemEl of stemCandidates(doc)) {
    if (!isVisible(stemEl) || stemEl.querySelector(CHOICE_SELECTOR)) continue;
    const match = findChoiceBoxes(stemEl, usedGroups);
    if (!match || match.boxes.some((box) => claimed.has(box))) continue;
    if (isExcludedContext(match.group)) continue;
    const choices = match.boxes.map((box) => readText(box));
    const ownText = readText(stemEl, { exclude: (element) => element === match.group });
    const stem = cleanStem(withPageContext(ownText, doc));
    if (!stem || stem.text.length > MAX_GENERIC_STEM_CHARS) continue;
    if (!isLooseAssessmentQuestion(stem.text, assessmentPage)) continue;
    const question = buildQuestion({
      kind: MULTI_SELECT.test(stem.text) ? 'multiple' : 'single',
      stem,
      choices,
      label: questionLabel(stemEl),
      source: 'generic',
    });
    if (!question) continue;
    usedGroups.add(match.group);
    match.boxes.forEach((box) => claimed.add(box));
    found.push({ data: question, root: match.root, targets: match.boxes.map((box) => [box]) });
  }
  return found;
}

/** Innermost elements that name themselves a question, plus headings and paragraphs ending in "?". */
function stemCandidates(doc: Document): Element[] {
  const hinted = Array.from(doc.querySelectorAll('[id], [class]')).filter((element) => {
    const names = `${element.id} ${element.getAttribute('class') ?? ''}`;
    return STEM_HINT.test(names) && !CHOICE_HINT.test(names) && element.tagName !== 'BODY' && element.tagName !== 'HTML';
  });
  const asked = Array.from(doc.querySelectorAll('h2, h3, h4, h5, h6, p, legend')).filter((element) =>
    /\?\s*$/.test(element.textContent ?? ''),
  );
  const all = [...new Set([...hinted, ...asked])];
  return all.filter((element) => !all.some((other) => other !== element && element.contains(other)));
}

interface ChoiceBoxes {
  group: Element;
  boxes: Element[];
  root: Element;
}

/** The nearest box group inside or after the question, looking at most three ancestors up. */
function findChoiceBoxes(stemEl: Element, used: Set<Element>): ChoiceBoxes | null {
  let scope: Element | null = stemEl;
  for (let depth = 0; scope && depth <= 3 && scope.tagName !== 'BODY'; depth += 1, scope = scope.parentElement) {
    const descendants = Array.from(scope.querySelectorAll('*'));
    if (descendants.length > MAX_SCOPE_ELEMENTS) return null;
    let fallback: ChoiceBoxes | null = null;
    for (const element of [scope, ...descendants]) {
      if (used.has(element) || element === stemEl || element.contains(stemEl)) continue;
      if (!stemEl.contains(element) && !(stemEl.compareDocumentPosition(element) & 4)) continue;
      const boxes = choiceBoxes(element);
      if (!boxes) continue;
      const hinted = boxes.some((box) => CHOICE_HINT.test(`${box.id} ${box.getAttribute('class') ?? ''}`));
      if (hinted) return { group: element, boxes, root: scope };
      fallback ??= { group: element, boxes, root: scope };
    }
    if (fallback) return fallback;
  }
  return null;
}

/** The visible children of an element when they form one row of answer boxes. */
function choiceBoxes(element: Element): Element[] | null {
  const children = Array.from(element.children).filter((child) => !SKIPPED_TAGS.has(child.tagName) || child.tagName === 'BUTTON');
  const boxes = children.filter((child) => isVisible(child) && !isHiddenForText(child));
  if (boxes.length < 2 || boxes.length > MAX_BOX_CHOICES) return null;
  const tag = boxes[0]?.tagName;
  if (boxes.some((box) => box.tagName !== tag)) return null;
  const texts: string[] = [];
  for (const box of boxes) {
    if (!looksClickable(box)) return null;
    if (box.querySelector('input, select, textarea, a[href], [role="radio"], [role="checkbox"]')) return null;
    if (box.matches('a[href], [role="tab"], [role="menuitem"], [role="link"]')) return null;
    const text = readText(box).text;
    if (!text || text.length > MAX_BOX_CHOICE_CHARS || CONTROL_TEXT.test(text)) return null;
    texts.push(normalizeText(text));
  }
  return new Set(texts).size === texts.length ? boxes : null;
}

function looksClickable(box: Element): boolean {
  if (box.tagName === 'BUTTON') return true;
  const role = box.getAttribute('role');
  if (role === 'button' || role === 'option') return true;
  if (box.hasAttribute('onclick') || box.hasAttribute('tabindex')) return true;
  return CHOICE_HINT.test(`${box.id} ${box.getAttribute('class') ?? ''}`);
}

/** A bare prompt such as "Alabama" is sent with the quiz title so the question makes sense. */
function withPageContext(stem: TextResult, doc: Document): TextResult {
  if (QUESTION_LIKE.test(stem.text) || stem.text.length >= 80) return stem;
  const heading = tidyText(doc.querySelector('h1')?.textContent ?? '').slice(0, 200);
  if (!heading || stem.text.includes(heading)) return stem;
  return { text: `${heading}\n${stem.text}`, hasImages: stem.hasImages };
}

/**
 * Static lettered answer lists, as on sample-question pages: paragraphs or list items starting
 * "A.", "B.", "(C)" in sequence, or an <ol type="A">, preceded by the question wording.
 */
function extractLetteredLists(doc: Document, claimed: Set<Element>, assessmentPage: boolean): ExtractedQuestion[] {
  const found: ExtractedQuestion[] = [];
  const seen = new Set<Element>();
  for (const run of letteredRuns(doc)) {
    const { options, anchor } = run;
    if (options.some((option) => seen.has(option) || claimed.has(option) || option.querySelector(CHOICE_SELECTOR))) continue;
    if (!isVisible(anchor) || isExcludedContext(anchor)) continue;
    const stemResult = precedingStem(anchor);
    if (!stemResult) continue;
    const choices = options.map((option) => {
      const text = readText(option);
      return { text: text.text.replace(LETTER_MARKER, ''), hasImages: text.hasImages };
    });
    if (!isLooseAssessmentQuestion(stemResult.stem.text, assessmentPage)) continue;
    const question = buildQuestion({
      kind: MULTI_SELECT.test(stemResult.stem.text) ? 'multiple' : 'single',
      stem: stemResult.stem,
      choices,
      label: stemResult.label,
      source: 'generic',
    });
    if (!question) continue;
    options.forEach((option) => seen.add(option));
    found.push({ data: question, root: anchor.parentElement ?? anchor, targets: options.map((option) => [option]) });
  }
  return found;
}

interface LetteredRun {
  options: Element[];
  /** The first element of the answer list: the first option, or the <ol> holding them. */
  anchor: Element;
}

function letteredRuns(doc: Document): LetteredRun[] {
  const runs: LetteredRun[] = [];
  for (const list of Array.from(doc.querySelectorAll('ol'))) {
    const type = list.getAttribute('type') ?? '';
    const style = list.ownerDocument.defaultView?.getComputedStyle(list).listStyleType ?? '';
    if (type.toLowerCase() !== 'a' && !/alpha|latin/.test(style)) continue;
    const items = Array.from(list.children).filter((child) => child.tagName === 'LI');
    if (items.length >= 2 && items.length <= MAX_CHOICES) runs.push({ options: items, anchor: list });
  }
  for (const start of Array.from(doc.querySelectorAll('p, li, div, dd'))) {
    if (start.tagName === 'DIV' && start.childElementCount > 3) continue;
    if (letterOf(start) !== 'A') continue;
    const options = [start];
    for (let next = start.nextElementSibling; next && next.tagName === start.tagName; next = next.nextElementSibling) {
      if (letterOf(next) !== String.fromCharCode(65 + options.length)) break;
      options.push(next);
    }
    if (options.length >= 2) runs.push({ options, anchor: start });
  }
  return runs;
}

function letterOf(element: Element): string | null {
  const match = LETTER_MARKER.exec((element.textContent ?? '').trimStart().slice(0, 8));
  return match ? (match[1] as string) : null;
}

/** The paragraphs just before an answer list, back to a heading, rule or previous question. */
function precedingStem(anchor: Element): StemResult | null {
  const parts: Element[] = [];
  let label = '';
  for (let node = anchor.previousElementSibling; node && parts.length < 8; node = node.previousElementSibling) {
    if (/^H[1-6]$/.test(node.tagName)) {
      label = tidyText(node.textContent ?? '').slice(0, 80);
      break;
    }
    if (node.tagName === 'HR' || node.matches(CHOICE_SELECTOR) || node.querySelector(CHOICE_SELECTOR)) break;
    if (letterOf(node) !== null || node.tagName === 'OL' || node.tagName === 'UL') break;
    parts.unshift(node);
  }
  if (parts.length === 0) return null;
  const stem = cleanStem(joinResults(parts.map((part) => readText(part))));
  if (!stem || stem.text.length > MAX_GENERIC_STEM_CHARS) return null;
  return { stem, root: anchor.parentElement ?? anchor, label };
}
