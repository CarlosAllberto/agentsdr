import type { PromptDefinition } from "./types";

/** Transcribing a call's recording (src/lib/calls/transcription.ts). */
export const TRANSCRIPTION_PROMPTS = {
  "transcription/call": {
    description: "Sent with a call's stereo recording: who called whom (an outbound call, or a lead calling back), the lead's name and company when known, ringing to skip, and the transcript shape.",
    template: `This recording is a WhatsApp voice call — both sides of it — {{#inbound}}placed by a lead{{#who}} ({{who}}){{/who}} to a sales rep's number, and answered on the rep's side. The person who called is the lead and should be labeled "lead"; the one who answered is the rep and should be labeled "rep".{{/inbound}}{{^inbound}}placed by a sales rep to a lead{{#who}} ({{who}}){{/who}}. The rep is the caller and should be labeled "rep"; the person who was called is the lead and should be labeled "lead".{{/inbound}}

Transcribe the call in whatever language was actually spoken — Hindi, English, or a mix of both (Hinglish). Keep Hinglish as spoken; write Hindi words in Latin script if that's how they were said, don't translate them. Do not translate anything to English in the transcript itself.

For every distinct thing said:
- attribute it to "rep" or "lead" by who is speaking (role and voice, not word content)
- give "startSeconds" as a number of seconds from the very start of the recording
- merge consecutive fragments from the same speaker into one utterance rather than splitting a single thought

Then write a 2-3 sentence summary IN ENGLISH of the call, including any next step the two of them agreed to (a callback time, a meeting, information to be sent, etc.) — write "No next step was agreed." if none was.

Report the language you transcribed in as a short code ("en", "hi", "hi-en" for a Hindi/English mix), your summary, and the utterances.{{#ringing_seconds}}

The recording starts about {{ringing_seconds}} seconds before the lead picks up: ignore the ringing before that, and any speech in it is the rep's.{{/ringing_seconds}}`,
  },
} satisfies Record<string, PromptDefinition>;
