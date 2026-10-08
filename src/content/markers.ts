import { correctChoiceIndexes } from '../shared/answer';
import type { AnswerRecord } from '../shared/types';
import type { ExtractedQuestion } from './extract';

/**
 * Hovering an element carrying this attribute shows a tiny faint gray dot (see content.css).
 * Quieasy never moves the pointer, focuses, clicks or selects anything.
 */
export const MARK_ATTR = 'data-quieasy';
export const MARK_CORRECT = 'correct';

/**
 * Where the dot is drawn: centered inside a native radio or checkbox the browser draws itself
 * ("native"), or just after the choice's own content ("adjacent") for custom choices that
 * have no such control. One element per marked choice carries it.
 */
export const DOT_ATTR = 'data-quieasy-dot';
export type DotPlacement = 'native' | 'adjacent';

export function clearAllMarks(doc: Document): void {
  doc.querySelectorAll(`[${MARK_ATTR}], [${DOT_ATTR}]`).forEach((element) => {
    element.removeAttribute(MARK_ATTR);
    element.removeAttribute(DOT_ATTR);
  });
}

export function clearMarks(question: ExtractedQuestion): void {
  for (const element of question.targets.flat()) {
    element.removeAttribute(MARK_ATTR);
    element.removeAttribute(DOT_ATTR);
    element.querySelectorAll(`[${DOT_ATTR}]`).forEach((inner) => inner.removeAttribute(DOT_ATTR));
  }
}

/** Marks the choices this answer judges correct; returns how many choices were marked. */
export function applyMarks(question: ExtractedQuestion, answer: AnswerRecord | null | undefined): number {
  clearMarks(question);
  const indexes = correctChoiceIndexes(question.data.kind, question.data.choices, answer);
  for (const index of indexes) {
    const targets = question.targets[index] ?? [];
    targets.forEach((element) => element.setAttribute(MARK_ATTR, MARK_CORRECT));
    const dot = dotHost(targets);
    if (dot) dot.element.setAttribute(DOT_ATTR, dot.placement);
  }
  return indexes.length;
}

/**
 * Picks the element that draws the dot. A native control the user can see is preferred; it
 * must be one the page has not restyled, so the dot cannot hide a custom checkmark or move it.
 * Otherwise the dot goes after the first visible choice element whose ::after is unused.
 */
export function dotHost(targets: Element[]): { element: Element; placement: DotPlacement } | null {
  for (const target of targets) {
    const inputs = target.matches(NATIVE_CHOICE) ? [target] : Array.from(target.querySelectorAll(NATIVE_CHOICE));
    const input = inputs.find(isPlainVisibleControl);
    if (input) return { element: input, placement: 'native' };
  }
  for (const target of targets) {
    if (target instanceof HTMLInputElement || !hasBox(target)) continue;
    if (target.ownerDocument.defaultView?.getComputedStyle(target, '::after').content !== 'none') continue;
    return { element: target, placement: 'adjacent' };
  }
  return null;
}

const NATIVE_CHOICE = 'input[type="radio"], input[type="checkbox"]';
const MIN_CONTROL_PX = 8;

function isPlainVisibleControl(input: Element): boolean {
  const view = input.ownerDocument.defaultView;
  if (!view) return false;
  const style = view.getComputedStyle(input);
  const rect = input.getBoundingClientRect();
  if (rect.width < MIN_CONTROL_PX || rect.height < MIN_CONTROL_PX) return false;
  if (style.appearance !== 'auto' || style.visibility !== 'visible' || Number(style.opacity) < 0.5) return false;
  // The dot is centered with position: relative, which must not move the control.
  const offsets = [style.top, style.right, style.bottom, style.left];
  if (style.position !== 'relative' && (style.position !== 'static' || offsets.some((value) => value !== 'auto'))) return false;
  return view.getComputedStyle(input, '::after').content === 'none';
}

function hasBox(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
