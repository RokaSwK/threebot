import assert from "node:assert/strict";
import { test } from "node:test";
import { composeBotInstructions } from "../src/lib/botInstructions.ts";

test("the dialog's answers become the owner's part of the Bot's instructions", () => {
  assert.equal(composeBotInstructions({}), "");
  assert.equal(
    composeBotInstructions({ does: " Review the code. ", doesNot: " Don't push. ", style: " Spanish, direct. " }),
    "## What this Bot does\nReview the code.\n\n## What this Bot doesn't do\nDon't push.\n\n## How this Bot talks\nSpanish, direct.\n",
  );
});

test("empty answers are left out instead of producing empty headings", () => {
  assert.equal(composeBotInstructions({ does: "Review the code." }), "## What this Bot does\nReview the code.\n");
  assert.equal(composeBotInstructions({ style: "Spanish." }), "## How this Bot talks\nSpanish.\n");
});
