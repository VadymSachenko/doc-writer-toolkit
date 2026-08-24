---
id: MWSG-SHARED-BOTS
title: Bots and virtual agents
languages: [shared]
scope: structural
source_urls:
  - https://learn.microsoft.com/en-us/style-guide/chatbots-virtual-agents/
  - https://learn.microsoft.com/en-us/style-guide/chatbots-virtual-agents/structural-technical-considerations
  - https://learn.microsoft.com/en-us/style-guide/chatbots-virtual-agents/writing-bots
  - https://learn.microsoft.com/en-us/style-guide/chatbots-virtual-agents/care-feeding-bot
captured: 2026-07-16
status: active
keywords: [bot, virtual agent, conversation, escalation]
---

# Bots and virtual agents

## Fit and disclosure

- Use a bot when conversation is easier than navigation or search for the supported task.
- Identify it as a bot or virtual agent; do not imply that it is human.
- Explain its purpose, limits, common tasks, and how to reach a person.

## Conversation rules

- Adapt tone to context: calm and direct for security, billing, errors, or distress;
  lighter only for genuinely low-risk situations.
- Keep prompts and replies short and specific to the current context.
- Ask for clarification when intent is ambiguous. Confirm before destructive,
  irreversible, expensive, private, or security-sensitive actions.
- Do not add confirmation prompts to low-risk actions without a reason.
- Offer actionable buttons or examples when they can narrow ambiguous input.
- Recognize natural word order, incomplete requests, common misspellings, and common
  commands such as *help*, *start over*, and *stop*.
- Admit when the bot cannot answer. Provide a useful recovery path or human escalation.
- Break long responses into readable conversational turns without artificially rushing
  the reader.
- Close the conversation clearly when the task is complete.

## Person and pronouns

The bot may use first-person pronouns for itself. Controls selected by the customer
should reflect the customer's perspective when written in first person.

## Maintenance

- Collect direct feedback and ask whether the reader completed the task.
- Instrument conversation blocks so abandonment and failure points can be located.
- Review failures, escalation patterns, offensive or nonsense input, and new intents.
- Improve or retire the bot when evidence shows that it no longer adds value.

