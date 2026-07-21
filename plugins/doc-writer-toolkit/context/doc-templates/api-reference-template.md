---
title: {Meta title in imperative mood, for example, Retrieve products}
description: {Learn how to use API to complete_description}
last_update:
  date: {date in the m/d/yyyy format, for example, 2/22/2026}
---

{/*
TEMPLATE SCOPE: Single endpoint per page. For a page documenting related endpoints of one resource, write it manually.

PLACEHOLDER CONVENTIONS:
- {curly_braces}       = template placeholders for the writer to fill in. Remove before publishing.
- *`UPPER_CASE`*       = placeholders that remain in the published page for the reader to replace (per the style guide).

UNRESOLVED CONTENT: Use {/* ToDo: EXPLANATION */} for anything missing, unclear, or pending SME confirmation.
*/}

This document {resource description. Example: describes how to retrieve shipments and shipment methods when submitting checkout data.}

{List benefits for developers if applicable.}

{/* Optional: Include this section if the endpoint requires setup steps before it can be called (partner configuration, token generation, feature flags, etc.). Omit if none apply. */}
## Prerequisites

Before calling this endpoint, ensure the following:

- {Prerequisite 1. Example: You have generated an API token in the partner cabinet.}
- {Prerequisite 2. Example: Webhook URLs are configured for your partner account.}

## Authentication

{/* Mandatory section. State which token type authenticates this endpoint and which header carries it.

Check the brief's authentication field:
- "Standard" → use the standard two-row headers table in the ### Request section below. Keep this narrative text + link as-is.
- Custom data provided → replace the headers table rows in ### Request with the brief's data, and update the narrative text to match.
*/}

This endpoint requires {token type, for example, an API token} passed in the `{header name, for example, X-API-Token}` header.

For details, see [{Authentication page title}](/link/to/authentication-page.md).

## {Endpoint action} {/* in imperative mood, for example, Retrieve all products */}

To {action}, send the request:

---

`{METHOD} {base_url}/{endpoint}/{{path_parameter}}`
{/* Example: `GET https://api.unicompay.com/transaction/{{transaction_uuid}}`
     Use the real base URL for this endpoint's host group. Do not use example.com placeholders. */}

---

{/* Optional: Include this table only if the endpoint has path parameters. */}
| Path parameter | Description |
|---|---|
| `path_parameter` | {description} |

### Request

{/* Headers table rule:
- Brief says "Standard" → use the two rows below exactly as written. Do not modify.
- Brief provides custom auth data → replace the rows below with the brief's data.

Standard headers table (copy as-is when brief says "Standard"):
| Header key | Header value example | Required | Description |
|---|---|---|---|
| `ApiKey` | *`API_TOKEN`* | ✓ | Your API token: a 128-character lowercase alphanumeric string you generate during registration in your partner cabinet. |
| `Content-Type` | `application/json` | ✓ | Must be `application/json`. |
*/}

| Header key | Header value example | Required | Description |
|---|---|---|---|
|   |   | {add ✓ if required; leave blank otherwise} |   |


{/* Optional: Include this table only if the endpoint has query parameters. */}
| Query parameter | Required | Description | Possible values |
|---|---|---|---|
|   | {add ✓ if required; leave blank otherwise} |   |   |

{/* Optional: Include this info admonition only if specific combinations of included resources are required to achieve a particular result.
:::info["Included resources"]

If a particular combination of resources must be included in the request to achieve a particular result, explain it here. For example, "To include `bundled-products`, include `concrete-products` and `bundled-products` in the request."

:::
*/}

{/* Optional: Include this table only if the endpoint supports multiple request variants (for example, different ?include= combinations) that share the same request body or have no body. If the endpoint has a single request variant, omit this table and use the <details> block below. */}
| Request sample | Usage |
|---|---|
| `{METHOD} {endpoint}{parameter example}` | {usage description in imperative mood, for example, Retrieve all products} |
| `{METHOD} {endpoint}{parameter example}?include={included resource}` | {If including a resource requires other resources, describe only the target resource. For example, including `bundled-products` requires `concrete-products` and `bundled-products`. Describe the request as "Retrieve ... with bundled products", omitting the other resources.} |

<details>
<summary>Request sample: {request description, for example, Retrieve all products}</summary>

`{METHOD} {endpoint}{parameter example}` {/* usage description in imperative mood, for example, Retrieve all products */}

```{language}
{request body}
```
{/* Language: use `json` for JSON bodies, `bash` for cURL examples, `text` for plain strings. */}

</details>

{/* Optional: Include the Request body attributes table only if the endpoint accepts a request body. Omit for GET or DELETE endpoints with no body. */}
{/* Request body attributes table */}
#### Request body attributes

| Attribute | Type | Required | Description |
|---|---|---|---|
|   | {Array, Object, String, Boolean, Quantity, Integer (whole numbers only), Number (whole and decimal numbers)} | {add ✓ if required; leave blank otherwise} |   |

### Response

{/* Response sample must correspond to the request sample in the preceding section. */}

<details>
<summary>{response sample description}</summary>

```{language}
{response sample body}
```

</details>

{/* Optional: Include the following <details> block only for responses that contain included resources. If the request contains a required resource needed to include another resource, omit the required resource from the summary description. */}
<details>
<summary>Response sample with {included entity name}</summary>

```{language}
{response sample body}
```

</details>

{/* For long code blocks with sections, use H3 or H4 for section names (for example, General order information).
Describe only the attributes that are unique to this document. If attributes are already described in another section of this document, link to the table, not the section, using an anchor. */}

#### Response attributes

| Attribute | Type | Description |
|---|---|---|
|   | {Array, Object, String, Boolean, Quantity, Integer (whole numbers only), Number (whole and decimal numbers)} |   |

{/* Optional: Include the Included resource attributes table only if the response contains included resources that don't have a dedicated page. */}
#### Included resource attributes

| Included resource | Attribute | Type | Description |
|---|---|---|---|
|   |   | {Array, Object, String, Boolean, Quantity, Integer (whole numbers only), Number (whole and decimal numbers)} |   |

{/* Optional: Include the following list only if some included resources have dedicated pages with their own attribute tables. */}
For the attributes of the included resources, see:

- {Link to the table of an included resource's attribute descriptions}

{/* Optional: Include this section if the resource is used in combination with other resources or as part of another endpoint. */}
## Other management options

{Briefly describe and link to documents where this resource is used in combination with other resources. For example, as an included resource or as part of an endpoint of another resource.}

## Possible errors

{/* Only one errors table per document. Do not create separate tables in individual sections. */}

| Error | Reason |
|---|---|
| `{Error reason}` {/* application-level error code, for example, `field [Bank] must have value`. Do not list HTTP status codes here. */} | {/*Brief explanation of the code, for example, Invalid password.*/} |
 
For HTTP error codes and troubleshooting guidance, see [Error codes](/docs/error-codes/error-codes.md) 

## Next steps

{/* Briefly describe what the user can do after completing this task and link to relevant documents. Example: After submitting checkout data, you can place the order. For more information, see [Check out purchases](/link/to/check-out-purchases.md). */}