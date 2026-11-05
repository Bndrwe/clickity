// Greetings: the short italic-serif line each window opens with ("What can I help you see?"),
// a new one every time, in the manner of Claude's home screen. Pure data + a picker with no DOM
// dependency beyond an optional Storage, so it is unit tested (test/greetings.test.ts).
//
// Voice: warm, quiet, sentence case, two to seven words, no emoji, no exclamation marks.
// `{name}` is filled with the user's name (settings.userName) and only used when one is set.

export type GreetingContext = 'morning' | 'afternoon' | 'evening' | 'lateNight' | 'weekend' | 'monday' | 'friday' | 'any';

export const GREETINGS: Record<GreetingContext, readonly string[]> = {
  morning: [
    'Good morning.',
    'Good morning, {name}.',
    'Morning, {name}.',
    'A fresh morning.',
    'Coffee first, then pixels?',
    'Morning light, clear head.',
    'What shall we start with?',
    'The day is still blank.',
    'Ready for a new day?',
    'Up early, {name}?',
    'A quiet start.',
    'Nothing has gone wrong yet.',
    'Plenty of day ahead.',
    'What is first on the list?',
    'Early start, good.',
    'Let us ease into it.',
    'Morning, shall we begin?',
    'The inbox can wait a minute.',
    'Fresh coffee, fresh screen.',
    'Good morning, what are we seeing?',
    'A good day to figure things out.',
    'Rise and wonder.',
    'First question of the day?',
    'Take a breath, then ask.',
    'The morning is yours, {name}.',
    'What needs a second pair of eyes?',
    'Sun is up, so am I.',
    'Slow morning or busy one?',
    'Start small, {name}.',
    'Morning. Show me what you have.',
    'Awake and looking.',
    'Let us make a good start.',
    'Bright and early.',
    'Hello, early bird.',
    'What are we tackling today?',
    'A clean slate this morning.',
    'Tea or coffee, {name}?',
    'Breakfast for your brain.',
    'Morning, {name}. What is on screen?',
    'Another morning, another puzzle.',
    'The day begins here.',
  ],
  afternoon: [
    'Good afternoon.',
    'Good afternoon, {name}.',
    'Afternoon, {name}.',
    'Midday, still going strong.',
    'How is the day treating you?',
    'Halfway through, {name}.',
    'A good time to untangle something.',
    'Post-lunch focus?',
    'The afternoon stretch.',
    'What is on your screen?',
    'Need a hand with that?',
    'Let us get through this together.',
    'Afternoon light, steady pace.',
    'Still plenty of day left.',
    'What got stuck this afternoon?',
    'Back from lunch, {name}?',
    'A fresh pair of eyes, on call.',
    'Keep going, you are close.',
    'Afternoon, what is the question?',
    'Slow down or speed up?',
    'The middle of the day.',
    'Something puzzling you?',
    'Let us clear the afternoon.',
    'Hello again, {name}.',
    'Pick up where you left off.',
    'A quiet hour for good work.',
    'Anything I can look at?',
    'Tell me what you are seeing.',
    'The day is half done.',
    'Show me the tricky part.',
    'Right on time.',
    'Afternoon tea thoughts?',
    'Stretch, sip, then ask.',
    'Let us take it step by step.',
    'Good to see you, {name}.',
    'Where did the morning go?',
    'Another stretch of work ahead.',
    'Let us make this part easy.',
    'What are we working through?',
    'The sun is high. Ask away.',
  ],
  evening: [
    'Good evening.',
    'Good evening, {name}.',
    'Evening, {name}.',
    'Back at it, {name}?',
    'Winding down or winding up?',
    'The day is nearly done.',
    'One more thing before dinner?',
    'Golden hour for ideas.',
    'What is left on the list?',
    'Settle in, {name}.',
    'A calm evening, then.',
    'How did today go?',
    'Let us finish what matters.',
    'Evening. What are we looking at?',
    'The light is getting low.',
    'Almost time to rest.',
    'Tying up loose ends?',
    'Evening thoughts welcome.',
    'Anything left to figure out?',
    'Quiet hours, good for focus.',
    'After dinner, then?',
    'Slow evening, steady hands.',
    'What shall we wrap up?',
    'The city lights are coming on.',
    'Evening, shall we begin?',
    'A last look at today.',
    'Cozy corner, open window.',
    'Hello, {name}. Long day?',
    'Some evenings are for tinkering.',
    'Let us end the day well.',
    'Dusk and a good question.',
    'Tonight is yours, {name}.',
    'No rush this evening.',
    'Ease into the evening.',
    'Still got energy, {name}?',
    'Pour something warm and ask away.',
    'The day can wait. This cannot.',
    'Wind-down questions are fine too.',
  ],
  lateNight: [
    'Burning the midnight oil?',
    'Still up, {name}?',
    'Late night, quiet screen.',
    'The world is asleep. We are not.',
    'Night owl hours.',
    'Midnight thoughts welcome.',
    'Everything looks clearer at night.',
    'Quiet enough to think.',
    'One more thing, then sleep.',
    'The small hours, {name}.',
    'Nobody is watching. Ask anything.',
    'Past midnight and still curious.',
    'Late, but we can do this.',
    'Night shift, reporting in.',
    'Stars out, screen on.',
    'Cannot sleep, {name}?',
    'The best ideas come late.',
    'Hush hour. Go ahead.',
    'Soft light, long night.',
    'A late one, then.',
    'Quietly, what do you need?',
    'Deep night, deep focus.',
    'Still here, still looking.',
    'The night is long enough.',
    'Dark outside, bright in here.',
    'Moonlight and mysteries.',
    'Up late, {name}. I am too.',
    'One last puzzle for tonight?',
    'Everyone else is dreaming.',
    'Night mode, naturally.',
    'The house is quiet.',
    'Whisper your question.',
    'Let us not stay up too long.',
    'An hour for strange ideas.',
    'Late hours, gentle pace.',
    'Almost tomorrow already.',
    'Burning a little oil, {name}?',
    'Quiet night. Clear mind?',
  ],
  weekend: [
    'Happy weekend.',
    'Happy weekend, {name}.',
    'No rush, it is the weekend.',
    'A slow weekend, then.',
    'Weekend projects, {name}?',
    'Nowhere to be today.',
    'Lazy day or busy day?',
    'Time for the fun stuff.',
    'Saturday thoughts?',
    'Sunday, softly.',
    'Off the clock, still curious.',
    'The weekend is wide open.',
    'Tinkering allowed.',
    'What are we making this weekend?',
    'Pajamas and pixels?',
    'A day for ideas.',
    'Take it easy, {name}.',
    'Hobby hours begin.',
    'Weekend mode, gently on.',
    'Something just for you?',
    'No meetings today.',
    'Sunday is for slow questions.',
    'A perfect day to wander.',
    'Free day, free mind.',
    'Weekend, {name}. Breathe.',
    'Let us do something small and nice.',
    'Brunch for the brain.',
    'No deadlines, just curiosity.',
    'Saturday, the good kind.',
    'Weekend errands or weekend dreams?',
    'The long lazy stretch.',
    'Time is on your side.',
    'A day without an alarm.',
    'What did you save for today?',
    'Rest, then ask.',
    'Weekend, with a side of puzzles.',
    'Sunday reset?',
    'What sounds fun, {name}?',
    'Unhurried, as it should be.',
    'The week can wait.',
  ],
  monday: [
    'Happy Monday.',
    'Monday, {name}. Gently.',
    'A fresh week begins.',
    'Easy does it, it is Monday.',
    'New week, clean slate.',
    'Monday, but make it calm.',
    'Let us ease into the week.',
    'The week starts here.',
    'Here we go again, {name}.',
    'First things first.',
    'One step at a time this week.',
    'Monday morning momentum?',
    'Start the week small.',
    'The week is still unwritten.',
    'Monday plans, {name}?',
    'A soft landing into the week.',
    'You made it to Monday.',
    'Fresh week, fresh eyes.',
    'What is the week asking for?',
    'Big week or quiet one?',
    'Let us get the week going.',
    'Monday is only a day.',
    'Coffee, then Monday.',
    'The inbox can have a minute.',
    'Reset and begin.',
    'Start with the easy one.',
    'A week of good work ahead.',
    'Monday, {name}. Deep breath.',
  ],
  friday: [
    'Happy Friday.',
    'Friday, {name}. Nearly there.',
    'The weekend is close.',
    'Last stretch of the week.',
    'Finish strong, then rest.',
    'Friday feeling, {name}?',
    'One more push.',
    'Almost the weekend.',
    'Tie up the week.',
    'Friday light.',
    'The finish line is in sight.',
    'What is left before the weekend?',
    'Wrap it up nicely.',
    'You made it to Friday.',
    'A gentle end to the week.',
    'Friday, and the pace is easy.',
    'Clear the decks, {name}.',
    'Almost free.',
    'Last task of the week?',
    'Friday afternoon energy.',
    'Let us close the week well.',
    'A good week deserves a good ending.',
    'Nearly weekend, nearly done.',
    'The week is winding down.',
    'Friday, with a little hope.',
    'Make it a short one.',
    'Plans for the weekend, {name}?',
    'Home stretch.',
  ],
  any: [
    'What can I help you see?',
    'What are we figuring out?',
    'Ready when you are.',
    'Hello, {name}.',
    'Hey, {name}.',
    'Welcome back, {name}.',
    'Good to see you.',
    'What are you looking at?',
    'Show me what is on screen.',
    'Where shall we point?',
    'Ask me anything.',
    'What is on your mind?',
    'What shall we look at?',
    'A second pair of eyes.',
    'Let us take a look.',
    'I am all eyes.',
    'Looking for something?',
    'What is puzzling you?',
    'Tell me what you need.',
    'How can I help, {name}?',
    'Let us figure it out.',
    'What are we making?',
    'What would help right now?',
    'Right here, next to your cursor.',
    'Point me in the right direction.',
    'Lost something?',
    'Stuck on something?',
    'Let us untangle it.',
    'Where to?',
    'Curious about something?',
    'What needs explaining?',
    'Pick any window.',
    'What do you want to understand?',
    'I am listening.',
    'Say the word, {name}.',
    'Go ahead, I am here.',
    'Take your time.',
    'No question too small.',
    'Start anywhere.',
    'What are we looking for?',
    'Let us find it together.',
    'Need a nudge?',
    'Need a walkthrough?',
    'Show me the problem.',
    'Hand me the confusing part.',
    'Tell me where it hurts.',
    'Something odd on screen?',
    'What does this button do?',
    'Which window is misbehaving?',
    'Let us read between the pixels.',
    'Pixels, meet questions.',
    'I see you, {name}.',
    'Always glad to help.',
    'Together, then.',
    'Here whenever you need.',
    'The cursor is yours.',
    'Lead the way, {name}.',
    'Where does the trail begin?',
    'Click, point, understand.',
    'Hello again.',
    'Nice to have you back.',
    'Another good question, perhaps?',
    'What should we notice?',
    'Tell me what you see.',
    'A small question is fine.',
    'A big question is fine too.',
    'Let me see what you see.',
    'Eyes on the screen.',
    'Share a window, share a thought.',
    'What can we clear up?',
    'How about a walkthrough?',
    'Anything confusing today?',
    'Describe it or show it.',
    'Just say it out loud.',
    'Hold the key and talk.',
    'Type it or say it.',
    'Whisper or shout, I hear both.',
    'What are we learning today?',
    'Teach me your problem.',
    'Let us make sense of it.',
    'There is always a way through.',
    'Every mess has a thread.',
    'Pull the thread, {name}.',
    'One thing at a time.',
    'Small steps, clear screen.',
    'A calm place to ask.',
    'Quiet help, close by.',
    'No rush, no judgment.',
    'Ask the obvious thing.',
    'The obvious question is welcome.',
    'Wonder out loud.',
    'Let curiosity lead.',
    'What would you like to know?',
    'Here for the details.',
    'I like a good puzzle.',
    'Bring me a puzzle, {name}.',
    'Let us solve something.',
    'What are we building?',
    'Show your work.',
    'What is the plan?',
    'Where were we?',
    'Pick up the thread.',
    'Let us continue.',
    'What is next, {name}?',
    'Ready for the next thing.',
    'Tell me about your screen.',
    'I will follow your cursor.',
    'Your cursor, my compass.',
    'Right beside you.',
    'Close at hand.',
    'At your side, {name}.',
    'Beside the cursor, always.',
    'A little help, coming up.',
    'Consider me your sidekick.',
    'Pointing is my specialty.',
    'I know a shortcut or two.',
    'There is probably a button for that.',
    'Let me find the button.',
    'Ask, and I will point.',
    'What shall I point at?',
    'Name it, I will find it.',
    'Name the thing, {name}.',
    'The answer is on screen somewhere.',
    'Look closely together.',
    'Zoom in on the problem.',
    'Squint with me.',
    'Let us look closer.',
    'Another day, another window.',
    'Open a window, open a thought.',
    'Take a look around.',
    'See anything strange?',
    'Make yourself at home.',
    'Settle in.',
    'Stay a while, {name}.',
    'Welcome in.',
    'Hi there.',
    'Hi, {name}.',
    'Hello, friend.',
    'Well hello.',
    'There you are.',
    'So, {name}, what is up?',
    'What is new?',
    'What is the situation?',
    'Fill me in.',
    'Give me the short version.',
    'Start with the first thing.',
    'Where should I look first?',
    'What caught your eye?',
    'Something caught your eye?',
    'Spotted something?',
    'What did you find?',
    'Found something odd?',
    'Let us investigate.',
    'Let me think with you.',
    'Think out loud with me.',
    'Two heads, one screen.',
    'You bring the question.',
    'I bring the patience.',
    'Patience included.',
    'Plenty of patience here.',
    'Slow is fine.',
    'Quick is fine too.',
    'Whenever you are ready.',
    'Ready, steady.',
    'Say when.',
    'Go on, {name}.',
    'I am here.',
    'Speak up, or type.',
    'Hold, talk, let go.',
    'A hold and a word.',
    'Press, speak, done.',
    'Tell me, then watch.',
    'Watch the cursor fly.',
    'Follow the little arrow.',
    'The arrow knows the way.',
    'A small arrow, a big help.',
    'Quietly useful.',
    'Quietly watching.',
    'Calm, curious, close.',
    'Gently now.',
    'Begin with a question.',
    'Begin with what bothers you.',
    'What is bothering you?',
    'What feels hard?',
    'Where is it confusing?',
    'Which part is unclear?',
    'Which step is stuck?',
    'Where did it go wrong?',
    'What happened here?',
    'What changed?',
    'What is this thing?',
    'Why does it do that?',
    'How does this work?',
    'How do I do this?',
    'Teach me, and I will teach you.',
    'Let us learn something.',
    'Learn a thing today.',
    'A small win, perhaps?',
    'Let us get you unstuck.',
    'Unstuck in a minute.',
    'Almost there, probably.',
    'You are closer than you think.',
    'You have got this, {name}.',
    'Good questions get good answers.',
    'Let us work it out.',
    'We will sort it.',
    'It is probably simple.',
    'It is probably a setting.',
    'Check the settings, maybe.',
    'Let us check the menu.',
    'Start with the toolbar.',
    'Try the right-click.',
    'Anything hiding in the sidebar?',
    'There may be a shortcut.',
    'Your screen, explained.',
    'Explain this to me.',
    'Explain it like a friend.',
    'Plain words, always.',
    'No jargon, promise.',
    'Simple answers first.',
    'Short answers, kind ones.',
    'Brief and warm.',
    'Warm help, no fuss.',
    'No fuss, just help.',
    'Help without the hassle.',
    'Whatever you are doing, carry on.',
    'Carry on, I am watching kindly.',
    'Let me keep you company.',
    'Company for your cursor.',
    'A friend by your cursor.',
    'Your companion, reporting.',
    'On call, {name}.',
    'On standby.',
    'At your service, softly.',
    'What would you like to see?',
    'What can I show you?',
    'What can I point out?',
    'What can I explain?',
    'What can I clear up for you?',
    'How about a tour?',
    'Shall we explore?',
    'Let us explore.',
    'Explore with me.',
    'Wander with me.',
    'Where shall we wander?',
    'Take the scenic route.',
    'Or the shortcut.',
    'Whichever way you like.',
    'Your pace, your path.',
    'Your screen, your rules.',
    'It is your screen, {name}.',
    'You lead, I follow.',
    'I will keep up.',
    'Let me catch up.',
    'Catch me up.',
    'Tell me the story.',
    'Start from the beginning.',
    'Start in the middle.',
    'Begin wherever it hurts.',
    'Tell me a little more.',
    'One detail at a time.',
    'Detail by detail.',
    'Piece by piece.',
    'Bit by bit.',
    'Little by little.',
    'Step by step, {name}.',
    'First, a deep breath.',
    'Breathe. Then ask.',
    'All good here.',
    'All is well.',
    'We will be fine.',
    'Do not worry, ask.',
    'Worried about something?',
    'Nervous about a button?',
    'It will not bite.',
    'Think before you click.',
    'Ask before you click.',
    'Careful clicks, curious minds.',
    'Look twice, click once.',
    'Measure twice, ask once.',
    'Slow down, look around.',
    'Look around.',
    'Look up, look in.',
    'Looks interesting.',
    'That looks interesting, {name}.',
    'Something to see here.',
    'Plenty to see.',
    'A lot on screen today.',
    'A busy screen, I see.',
    'Tidy screen, tidy mind.',
    'Messy desktop? No judgment.',
    'Too many tabs?',
    'So many windows.',
    'Windows within windows.',
    'Let us tidy up the mess.',
    'Where did that go?',
    'Where is that setting?',
    'Where is that button?',
    'Where is the thing?',
    'Let us find the thing.',
    'Searching for something?',
    'Hide and seek, with menus.',
  ],
};

/* ───────────────────────── picker ───────────────────────── */

const NAME_SLOT = '{name}';
export const MAX_NAME_CHARS = 40;

export function hasNameSlot(line: string): boolean {
  return line.includes(NAME_SLOT);
}

/** Fill the {name} slot (names are trimmed, capped and stripped of braces). */
export function fillName(line: string, name: string): string {
  return line.split(NAME_SLOT).join(cleanName(name));
}

export function cleanName(name: unknown): string {
  return typeof name === 'string' ? name.replace(/[{}\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_CHARS) : '';
}

/** Every distinct line, for tests and tooling. */
export function allGreetings(): string[] {
  return Object.values(GREETINGS).flat();
}

/** Which time-of-day pool a local time falls in. */
export function timeOfDay(now: Date): 'morning' | 'afternoon' | 'evening' | 'lateNight' {
  const h = now.getHours();
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  if (h >= 17 && h < 22) return 'evening';
  return 'lateNight';
}

/** The day-specific pool for a date, if it has one (weekend, monday, friday). */
export function dayPool(now: Date): 'weekend' | 'monday' | 'friday' | null {
  const d = now.getDay();
  if (d === 0 || d === 6) return 'weekend';
  if (d === 1) return 'monday';
  if (d === 5) return 'friday';
  return null;
}

/** Share of greetings drawn from the any-time pool. */
export const ANY_SHARE = 0.3;
/** Chance of a day-specific line (when today has a pool) among the context-specific ones. */
const DAY_SHARE = 0.4;

export function chooseContext(now: Date, random: () => number = Math.random): GreetingContext {
  if (random() < ANY_SHARE) return 'any';
  const day = dayPool(now);
  if (day && random() < DAY_SHARE) return day;
  return timeOfDay(now);
}

interface QueueState {
  /** indices into the pool still unseen this round */
  queue: number[];
  size: number;
  named: boolean;
}

export interface PickOptions {
  /** the user's name (settings.userName); empty = never pick a {name} line */
  name?: string;
  now?: Date;
  /** persists the shuffled queues; omit (or a throwing one) for in-memory only */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** storage key suffix, one per window so each keeps its own rotation */
  scope?: string;
  random?: () => number;
  /** force a pool (tests) */
  context?: GreetingContext;
}

const memory = new Map<string, string>();

function read(storage: PickOptions['storage'], key: string): string | null {
  try {
    const v = storage?.getItem(key);
    if (typeof v === 'string') return v;
  } catch {}
  return memory.get(key) ?? null;
}
function write(storage: PickOptions['storage'], key: string, value: string): void {
  memory.set(key, value);
  try {
    storage?.setItem(key, value);
  } catch {}
}

function shuffle(n: number[], random: () => number): number[] {
  for (let i = n.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [n[i], n[j]] = [n[j]!, n[i]!];
  }
  return n;
}

function parseState(raw: string | null): QueueState | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as QueueState;
    if (s && Array.isArray(s.queue) && s.queue.every((x) => Number.isInteger(x)) && Number.isInteger(s.size) && typeof s.named === 'boolean') return s;
  } catch {}
  return null;
}

/**
 * Pick a greeting for now. Draws from a per-pool shuffled queue that is persisted, so a line is
 * not shown again until every line of its pool (that suits the name setting) has been shown.
 */
export function pickGreeting(opts: PickOptions = {}): string {
  const random = opts.random ?? Math.random;
  const now = opts.now ?? new Date();
  const name = cleanName(opts.name);
  const named = name.length > 0;
  const ctx = opts.context ?? chooseContext(now, random);
  const pool = GREETINGS[ctx];
  const key = `clickity.greetings.v1.${opts.scope ?? 'default'}.${ctx}`;

  let state = parseState(read(opts.storage, key));
  if (!state || state.size !== pool.length || state.named !== named) {
    // first run, an edited pool, or the name was set / cleared: start a fresh round
    state = { queue: [], size: pool.length, named };
  }
  state.queue = state.queue.filter((i) => i >= 0 && i < pool.length && (named || !hasNameSlot(pool[i]!)));
  if (!state.queue.length) {
    const eligible = pool.map((_, i) => i).filter((i) => named || !hasNameSlot(pool[i]!));
    state.queue = shuffle(eligible, random);
  }
  const idx = state.queue.shift()!;
  write(opts.storage, key, JSON.stringify(state));
  const line = pool[idx]!;
  return named ? fillName(line, name) : line;
}

/** localStorage when it works (renderer), else null. */
export function browserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
