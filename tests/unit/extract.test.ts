// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { extractQuestions, pageMode } from '../../src/content/extract';

const fixture = (name: string): string => readFileSync(join(import.meta.dirname, '..', 'fixtures', name), 'utf8');

function load(html: string): void {
  document.documentElement.innerHTML = new DOMParser().parseFromString(html, 'text/html').documentElement.innerHTML;
}

describe('Classic Quizzes extraction', () => {
  beforeEach(() => load(fixture('classic-quiz.html')));

  it('reads each visible question with its kind, wording and choices', () => {
    const questions = extractQuestions(document);
    expect(questions.map((question) => question.data)).toMatchObject([
      { kind: 'single', stem: 'What is the capital of Australia?', choices: ['Sydney', 'Canberra', 'Melbourne'], label: 'Question 1', source: 'canvas-classic' },
      { kind: 'multiple', stem: 'Which of these are prime numbers? Select all that apply.', choices: ['2', '9', '11'], label: 'Question 2' },
      { kind: 'single', choices: ['True', 'False'], label: 'Question 3' },
    ]);
  });

  it('maps each choice to the answer row the user hovers', () => {
    const [first] = extractQuestions(document);
    expect(first?.targets.map((targets) => targets.map((element) => element.className))).toEqual([['answer'], ['answer'], ['answer']]);
    expect(first?.targets[1]?.[0]?.textContent).toContain('Canberra');
  });

  it('ignores the hidden question template and page text outside questions', () => {
    const questions = extractQuestions(document);
    expect(questions).toHaveLength(3);
    expect(JSON.stringify(questions.map((question) => question.data))).not.toContain('Open notes');
  });
});

describe('New Quizzes style extraction', () => {
  it('reads the item body as the question and the labels as choices', () => {
    load(fixture('new-quizzes-frame.html'));
    const [question] = extractQuestions(document);
    expect(question?.data).toMatchObject({
      kind: 'single',
      stem: 'Which planet is the largest in our solar system?',
      choices: ['Mars', 'Jupiter', 'Venus'],
      source: 'canvas-new-quizzes',
    });
    expect(question?.targets[1]?.[0]?.textContent).toContain('Jupiter');
  });

  it('skips radio groups that have no question wording', () => {
    load(
      '<div data-automation="sdk-take-item-question"><form><label><input type="radio" name="a">Yes</label><label><input type="radio" name="a">No</label></form></div>',
    );
    expect(extractQuestions(document)).toHaveLength(0);
  });
});

describe('non-quiz Canvas pages', () => {
  it('reads nothing from the notification settings page', () => {
    load(fixture('canvas-notifications.html'));
    expect(extractQuestions(document)).toEqual([]);
  });

  it('reads nothing from radio or checkbox groups outside a New Quizzes item', () => {
    load(
      '<form><fieldset><legend>Which of the following days comes first in the week?</legend>' +
        '<label><input type="radio" name="day">Monday</label><label><input type="radio" name="day">Friday</label></fieldset></form>',
    );
    expect(extractQuestions(document, 'canvas')).toEqual([]);
  });

  it('treats Canvas on a school domain as Canvas', () => {
    load('<div id="application" class="ic-app"></div>');
    expect(pageMode(document)).toBe('canvas');
  });
});

/** Loads a fixture as a page of its own, with its title, as the generic extractor sees it. */
function loadPage(name: string): void {
  // Frames are read by their own content script copy; parsing their src here would fetch from the network.
  const html = fixture(name).replace(/(<iframe\b[^>]*?)\ssrc="[^"]*"/g, '$1');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  parsed.querySelectorAll('script').forEach((script) => script.remove());
  document.title = parsed.title;
  document.documentElement.innerHTML = parsed.documentElement.innerHTML;
}

describe('other sites', () => {
  it('reads native, sibling-layout and ARIA custom questions from a practice quiz', () => {
    loadPage('practice-quiz.html');
    const questions = extractQuestions(document, 'generic');
    expect(questions.map((question) => question.data)).toMatchObject([
      { kind: 'single', stem: '1. What is the powerhouse of the cell?', choices: ['Nucleus', 'Mitochondria', 'Ribosome'], source: 'generic' },
      { kind: 'multiple', stem: '2. Which of these are noble gases? Select all that apply.', choices: ['Helium', 'Nitrogen', 'Neon', 'Oxygen'] },
      { kind: 'single', stem: '3. Which blood cells carry oxygen around the body?', choices: ['White blood cells', 'Red blood cells', 'Platelets'] },
      { kind: 'single', stem: '4. Which organelle carries out photosynthesis in plant cells?', choices: ['Golgi apparatus', 'Chloroplast', 'Lysosome'] },
    ]);
    const all = JSON.stringify(questions.map((question) => question.data));
    for (const outside of ['text size', 'countdown timer', 'study tips', 'Open book']) expect(all).not.toContain(outside);
    // Hovering the label text or the whole row both count.
    expect(questions[2]?.targets[1]?.map((element) => element.tagName)).toEqual(['LI']);
    expect(questions[3]?.targets[1]?.[0]?.id).toBe('q4b');
  });

  it('reads the question text that sits beside the choices inside their own container', () => {
    load(
      '<h1>Chapter 2 Practice Test</h1><p>Answer every question before you submit.</p><form>' +
        '<div class="question"><p>1. What is the powerhouse of the cell?</p>' +
        '<label><input type="radio" name="q1">Nucleus</label><label><input type="radio" name="q1">Mitochondria</label></div>' +
        '<div class="question"><p>2. Which gas do plants absorb from the air?</p>' +
        '<label><input type="radio" name="q2">Oxygen</label><label><input type="radio" name="q2">Carbon dioxide</label></div>' +
        '</form>',
    );
    document.title = 'Chapter 2 Practice Test';
    expect(extractQuestions(document, 'generic').map((question) => question.data)).toMatchObject([
      { stem: '1. What is the powerhouse of the cell?', choices: ['Nucleus', 'Mitochondria'] },
      { stem: '2. Which gas do plants absorb from the air?', choices: ['Oxygen', 'Carbon dioxide'] },
    ]);
  });

  it('reads a single question below the page heading and intro, not the heading and intro', () => {
    load(
      '<h1>Daily Quiz</h1><p>One question a day, every day.</p>' +
        '<div class="question"><p>Which planet is closest to the Sun?</p>' +
        '<label><input type="radio" name="q">Mercury</label><label><input type="radio" name="q">Venus</label></div>',
    );
    document.title = 'Daily Quiz';
    expect(extractQuestions(document, 'generic').map((question) => question.data)).toMatchObject([
      { stem: 'Which planet is closest to the Sun?', choices: ['Mercury', 'Venus'] },
    ]);
  });

  it('reads a Moodle multichoice question and drops its "Select one:" prompt', () => {
    load(
      '<div class="que multichoice"><div class="content"><div class="formulation">' +
        '<h4 class="no">Question <span class="qno">1</span></h4>' +
        '<div class="qtext"><p>Which organelle makes most of the cell\'s ATP?</p></div>' +
        '<div class="ablock"><div class="prompt">Select one:</div><div class="answer">' +
        '<div class="r0"><input type="radio" name="q1:1_answer" id="q1a"><label for="q1a"><span class="answernumber">a. </span>Ribosome</label></div>' +
        '<div class="r1"><input type="radio" name="q1:1_answer" id="q1b"><label for="q1b"><span class="answernumber">b. </span>Mitochondrion</label></div>' +
        '</div></div></div></div></div>',
    );
    document.title = 'Quiz: Cells';
    expect(extractQuestions(document, 'generic').map((question) => question.data)).toMatchObject([
      { stem: "Which organelle makes most of the cell's ATP?", choices: ['a. Ribosome', 'b. Mitochondrion'], label: 'Question 1' },
    ]);
  });

  it('reads the question above a prompt line that sits inside the options block or the legend', () => {
    load(
      '<div class="question"><p>Which organelle makes most of the cell\'s ATP?</p><div class="options"><p>Choose 1 answer:</p>' +
        '<label><input type="radio" name="q1">Ribosome</label><label><input type="radio" name="q1">Mitochondrion</label></div></div>' +
        '<div class="question"><p>Which gas do plants absorb from the air?</p><fieldset><legend>Choose 1 answer:</legend>' +
        '<label><input type="radio" name="q2">Oxygen</label><label><input type="radio" name="q2">Carbon dioxide</label></fieldset></div>' +
        '<div class="question"><p>Which blood cells carry oxygen?</p><fieldset><legend>Possible answers</legend>' +
        '<label><input type="radio" name="q3">Platelets</label><label><input type="radio" name="q3">Red blood cells</label></fieldset></div>',
    );
    document.title = 'Quiz: Cells';
    expect(extractQuestions(document, 'generic').map((question) => question.data.stem)).toEqual([
      "Which organelle makes most of the cell's ATP?",
      'Which gas do plants absorb from the air?',
      'Which blood cells carry oxygen?',
    ]);
  });

  it('keeps a sentence-completion stem beside the choices over farther text that ends in "?"', () => {
    load(
      '<div id="root"><header><a href="/help">Need help?</a></header><div class="question"><p>The powerhouse of the cell is the</p>' +
        '<label><input type="radio" name="q1">Nucleus</label><label><input type="radio" name="q1">Mitochondrion</label></div></div>',
    );
    document.title = 'Quiz: Cells';
    expect(extractQuestions(document, 'generic').map((question) => question.data.stem)).toEqual(['The powerhouse of the cell is the']);

    load(
      '<form><p>Ready to test yourself?</p><div class="question"><p>The powerhouse of the cell is the</p>' +
        '<label><input type="radio" name="q1">Nucleus</label><label><input type="radio" name="q1">Mitochondrion</label></div>' +
        '<div class="question"><p>Plants take in carbon dioxide through their</p>' +
        '<label><input type="radio" name="q2">Roots</label><label><input type="radio" name="q2">Stomata</label></div></form>',
    );
    document.title = 'Quiz: Cells';
    expect(extractQuestions(document, 'generic').map((question) => question.data.stem)).toEqual([
      'The powerhouse of the cell is the',
      'Plants take in carbon dioxide through their',
    ]);

    load(
      '<div id="page"><div class="nav"><a href="/login">Forgot your password?</a></div><div class="que multichoice">' +
        '<div class="qtext"><p>The organelle that makes most ATP is the</p></div>' +
        '<div class="ablock"><div class="prompt">Select one:</div><div class="answer">' +
        '<div class="r0"><input type="radio" name="q1" id="m1"><label for="m1">Ribosome</label></div>' +
        '<div class="r1"><input type="radio" name="q1" id="m2"><label for="m2">Mitochondrion</label></div>' +
        '</div></div></div></div>',
    );
    document.title = 'Quiz: Cells';
    expect(extractQuestions(document, 'generic').map((question) => question.data.stem)).toEqual(['The organelle that makes most ATP is the']);
  });

  it('keeps imperative stems such as "Select the prime number:" as the question', () => {
    load(
      '<form><div class="question"><p>Select the prime number:</p>' +
        '<label><input type="radio" name="q1">4</label><label><input type="radio" name="q1">7</label></div>' +
        '<div class="question"><p>Pick the odd one out:</p>' +
        '<label><input type="radio" name="q2">Apple</label><label><input type="radio" name="q2">Carrot</label></div></form>',
    );
    document.title = 'Quiz: Numbers';
    expect(extractQuestions(document, 'generic').map((question) => question.data.stem)).toEqual([
      'Select the prime number:',
      'Pick the odd one out:',
    ]);

    load(
      '<div id="root"><h1>Daily Numbers Quiz</h1><p>Sharpen your mind every morning.</p><div class="question"><p>Select the prime number:</p>' +
        '<label><input type="radio" name="q1">4</label><label><input type="radio" name="q1">7</label></div></div>',
    );
    document.title = 'Quiz: Numbers';
    expect(extractQuestions(document, 'generic').map((question) => question.data)).toMatchObject([
      { stem: 'Select the prime number:', choices: ['4', '7'] },
    ]);

    load(
      '<form><div class="question"><p>Select the odd one</p>' +
        '<label><input type="radio" name="q1">4</label><label><input type="radio" name="q1">Apple</label></div>' +
        '<div class="question"><p>Choose the correct one</p>' +
        '<label><input type="radio" name="q2">2 + 2 = 5</label><label><input type="radio" name="q2">2 + 2 = 4</label></div></form>',
    );
    document.title = 'Quiz: Numbers';
    expect(extractQuestions(document, 'generic').map((question) => question.data.stem)).toEqual([
      'Select the odd one',
      'Choose the correct one',
    ]);

    load(
      '<div id="root"><h1>Daily Numbers Quiz</h1><p>Sharpen your mind every morning.</p><div class="question"><p>Select the odd one</p>' +
        '<label><input type="radio" name="q1">4</label><label><input type="radio" name="q1">Apple</label></div></div>',
    );
    document.title = 'Quiz: Numbers';
    expect(extractQuestions(document, 'generic').map((question) => question.data)).toMatchObject([
      { stem: 'Select the odd one', choices: ['4', 'Apple'] },
    ]);
  });

  it('reads bare inputs followed by their wording without pulling that wording into the question', () => {
    load(
      '<div class="question"><p>Which planet is closest to the Sun?</p>' +
        '<input type="radio" name="q" id="a"> Mercury<br><input type="radio" name="q" id="b"> Venus<br></div>',
    );
    document.title = 'Daily Quiz';
    const [question] = extractQuestions(document, 'generic');
    expect(question?.data).toMatchObject({ stem: 'Which planet is closest to the Sun?', choices: ['Mercury', 'Venus'] });
    expect(question?.targets.map((targets) => targets.map((element) => element.id))).toEqual([['a'], ['b']]);
  });

  it('reads a question about the US on an ordinary page but still skips one that addresses us', () => {
    load(
      '<form><div class="question"><p>Which state has the largest population in the US?</p>' +
        '<label><input type="radio" name="q1">Texas</label><label><input type="radio" name="q1">California</label></div>' +
        '<div class="question"><p>Which plan is best for us?</p>' +
        '<label><input type="radio" name="q2">Monthly</label><label><input type="radio" name="q2">Yearly</label></div></form>',
    );
    document.title = 'Chapter 5 Review';
    expect(extractQuestions(document, 'generic').map((question) => question.data.stem)).toEqual([
      'Which state has the largest population in the US?',
    ]);
  });

  it('reads nothing from an ordinary settings page', () => {
    loadPage('account-settings.html');
    expect(extractQuestions(document, 'generic')).toEqual([]);
  });

  it('reads nothing from the Canvas notification page even without Canvas detection', () => {
    loadPage('canvas-notifications.html');
    expect(extractQuestions(document, 'generic')).toEqual([]);
  });

  it('skips preference questions on pages that are not assessments', () => {
    load(
      '<form><fieldset><legend>Which day should your weekly summary arrive?</legend>' +
        '<label><input type="radio" name="day">Monday</label><label><input type="radio" name="day">Friday</label></fieldset></form>',
    );
    expect(extractQuestions(document, 'generic')).toEqual([]);
  });

  it('reads clickable answer boxes in a trivia game, not the prev/next buttons', () => {
    loadPage('trivia-game.html');
    document.querySelector('#currQuestion')!.textContent = 'Which initial appears before Montgomery Burns in his name on The Simpsons?';
    document.querySelectorAll('#quiz-wrapper .text').forEach((text, index) => (text.textContent = 'ABCD'[index]!));
    const questions = extractQuestions(document, 'generic');
    expect(questions.map((question) => question.data)).toMatchObject([
      { kind: 'single', stem: 'Which initial appears before Montgomery Burns in his name on The Simpsons?', choices: ['A', 'B', 'C', 'D'] },
    ]);
    expect(questions[0]?.targets.map((targets) => targets[0]?.id)).toEqual(['box1', 'box2', 'box3', 'box4']);
  });

  it('adds the quiz title to a bare prompt such as a state name', () => {
    loadPage('trivia-game.html');
    document.querySelector('h1')!.textContent = 'Which Is the US State Capital?';
    document.querySelector('#currQuestion')!.textContent = 'Alabama';
    ['Montgomery', 'Birmingham', 'Tuscaloosa', 'Mobile'].forEach((name, index) => {
      document.querySelectorAll('#quiz-wrapper .text')[index]!.textContent = name;
    });
    expect(extractQuestions(document, 'generic')[0]?.data.stem).toBe('Which Is the US State Capital?\nAlabama');
  });

  it('reads static lettered answer lists but not an ordinary lettered outline', () => {
    loadPage('sample-questions.html');
    const questions = extractQuestions(document, 'generic');
    expect(questions.map((question) => question.data)).toMatchObject([
      {
        kind: 'single',
        label: 'Multiple-Choice Question 1',
        choices: [
          'The buyer may evict the tenant immediately.',
          'The buyer takes the building subject to the lease.',
          'The lease ended automatically when the building was sold.',
          'The tenant must sign a new lease with the buyer.',
        ],
      },
      { kind: 'multiple', stem: 'Which of the following are primary colors of light? Select two.', choices: ['Red', 'Yellow', 'Blue', 'Brown'] },
    ]);
    expect(questions[0]?.data.stem).toMatch(/^A tenant signs .*Select one\.$/s);
    expect(JSON.stringify(questions.map((question) => question.data))).not.toContain('correct answer is');
  });

  it('reads no ordinary lettered list or button row on a page that is not a quiz', () => {
    load(
      '<h1>Release notes</h1><p>What changed in this version?</p><p>A. Faster start-up</p><p>B. New icons</p>' +
        '<h2>Need help?</h2><div><button>Contact us</button><button>Read the docs</button></div>',
    );
    expect(extractQuestions(document, 'generic')).toEqual([]);
  });
});

describe('question keys', () => {
  it('match for shuffled copies of a question and differ when the wording changes', () => {
    load(fixture('classic-quiz.html'));
    const original = extractQuestions(document)[0]?.data.key;
    const labels = document.querySelectorAll('#question_101 .answer_label');
    labels[0]!.textContent = 'Melbourne';
    labels[2]!.textContent = 'Sydney';
    expect(extractQuestions(document)[0]?.data.key).toBe(original);
    document.querySelector('#question_101_question_text')!.innerHTML = '<p>What is the capital of Austria?</p>';
    expect(extractQuestions(document)[0]?.data.key).not.toBe(original);
  });
});
