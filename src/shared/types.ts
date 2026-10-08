/** A radio-style question has exactly one answer; a checkbox-style one may have several. */
export type QuestionKind = 'single' | 'multiple';

/** Where a question was read: Canvas Classic Quizzes, Canvas New Quizzes, or another site. */
export type QuestionSource = 'canvas-classic' | 'canvas-new-quizzes' | 'generic';

/** Everything Quieasy ever sends to the AI service about a question. */
export interface QuestionData {
  /** Stable content hash: same question text and choice set give the same key. */
  key: string;
  kind: QuestionKind;
  stem: string;
  choices: string[];
  /** True when the question or its choices contain images that are not sent. */
  hasImages: boolean;
  /** Page label such as "Question 3", used only in the answer key. */
  label: string;
  source: QuestionSource;
}

export interface Source {
  url: string;
  title: string;
}

export type Confidence = 'high' | 'medium' | 'low';

/**
 * answered: a definite answer whose correct choices get the faint gray hover dot.
 * unsure: the model could not determine the answer (no dot is shown).
 * error: the request failed (no dot is shown).
 */
export type AnswerStatus = 'answered' | 'unsure' | 'error';

export interface AnswerRecord {
  key: string;
  status: AnswerStatus;
  /** Normalized texts of the choices judged correct. Empty unless status is answered. */
  correct: string[];
  confidence: Confidence | null;
  explanation: string;
  /** Sources the model relied on, restricted to URLs its web searches actually returned. */
  sources: Source[];
  /** Search results the model saw, for transparency in the answer key. */
  searched: Source[];
  searches: number;
  model: string;
  error: string | null;
  timing: {
    /** Time spent waiting for a free request slot. */
    queuedMs: number;
    /** Network round trip including web search and model time. */
    providerMs: number;
  };
  at: number;
}

export interface QuieasyState {
  enabled: boolean;
  changedAt: number;
}

/** What a content script frame reports about the questions it can see. */
export interface FrameReport {
  questions: QuestionData[];
  extractMs: number;
  /** Per question key, time from answer arrival to markers applied. */
  displayMs: Record<string, number>;
  updatedAt: number;
}

export type ContentMessage =
  | { type: 'questions'; questions: QuestionData[]; extractMs: number }
  | { type: 'displayed'; key: string; displayMs: number };

export type UiMessage =
  | { type: 'setEnabled'; enabled: boolean; tabId?: number }
  | { type: 'answerKey'; tabId: number }
  | { type: 'retry'; key: string }
  | { type: 'settingsChanged' }
  | { type: 'injectTab'; tabId: number };

export interface AnswerKeyEntry {
  question: QuestionData;
  answer: AnswerRecord | null;
  pending: boolean;
  extractMs: number;
  displayMs: number | null;
}

export interface AnswerKeyResponse {
  enabled: boolean;
  /** What the user still has to set up before answers can be looked up, or null when ready. */
  setupNeeded: string | null;
  /** A question in this tab was not looked up because the tab used up its allowance (see MAX_LOOKUPS_PER_TAB). */
  lookupLimitReached: boolean;
  entries: AnswerKeyEntry[];
}
