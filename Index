import pkg from "@slack/bolt";
const { App } = pkg;
import dotenv from "dotenv";
dotenv.config();

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
});

// Handle all DMs
app.message(async ({ message, say }) => {
  // Ignore bot messages and message subtypes (edits, deletes, etc.)
  if (message.bot_id || message.subtype) return;

  await say({
    text: "I heard you.",
    thread_ts: message.ts,
  });
});

(async () => {
  await app.start();
  console.log("CandiBot is running");
})();
