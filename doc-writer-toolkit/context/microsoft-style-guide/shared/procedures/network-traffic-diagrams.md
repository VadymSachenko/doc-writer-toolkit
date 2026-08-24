---
id: MWSG-SHARED-NETWORK-DIAGRAMS
title: Network traffic diagrams
languages: [shared]
scope: structural
source_urls:
  - https://learn.microsoft.com/en-us/style-guide/procedures-instructions/illustrating-network-traffic-flows
captured: 2026-07-16
status: active
keywords: [network, diagram, traffic, ports, protocols]
---

# Network traffic diagrams

- Always include a legend for visual conventions.
- Use accessible contrast and distinguish flows by more than color.
- Use sentence-style capitalization in labels.
- Use a single-headed arrow when one endpoint initiates communication and a
  double-headed arrow when either endpoint can initiate it.
- Use consistent line styles and keep them distinguishable in grayscale.
- Put a traffic label on its line when possible; otherwise use a clear callout.
- Show a security boundary with a solid vertical line and draw traffic across it.
- List protocol names from highest to lowest layer.
- Identify UDP explicitly. Omit known TCP and dynamic source-port details only when the
  shorter label cannot mislead the reader.
- Do not use thousands separators in port numbers. Use `dyn` for a dynamic source range.

**Recommended label:** `HTTPS/TCP dyn->443`  
**Acceptable compact label when unambiguous:** `HTTPS`

