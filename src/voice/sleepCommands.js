// Whole-utterance only, so "goodnight moon lyrics" still goes to the agent.
const PREFIX = String.raw`^(?:(?:hey |ok |okay )?jarvis[,.]? )?`;
const SUFFIX = String.raw`(?:,? jarvis)?[.!]?$`;

const SLEEP = new RegExp(
  `${PREFIX}(?:good ?night|night night|nighty night|go to sleep|sleep mode|(?:go |turn )?(?:in)?to sleep mode|time (?:for|to go to) bed|(?:i'?m |i am )?(?:going|heading|off) to (?:bed|sleep))${SUFFIX}`,
  'i',
);
const WAKE = new RegExp(
  `${PREFIX}(?:good ?morning|wake up|rise and shine|i'?m (?:awake|up)|i am (?:awake|up))${SUFFIX}`,
  'i',
);

const clean = (text) =>
  String(text || '')
    .trim()
    .replace(/[’‘]/g, "'");

/** "Goodnight, Jarvis", "I'm going to bed", "sleep mode". */
export function isSleepCommand(text) {
  return SLEEP.test(clean(text));
}

/** "Good morning", "wake up", "I'm up". */
export function isWakeCommand(text) {
  return WAKE.test(clean(text));
}
