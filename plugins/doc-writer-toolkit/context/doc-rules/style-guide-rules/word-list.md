---
title: Word list
description: Learn how to use specific words and phrases in documentation
last_update:
  date: 4/19/2026
---

This word list provides guidance on specific words and phrases commonly used in documentation.

For the full version of the word list, see the Google developer documentation style guide page [Word list](https://developers.google.com/style/word-list).

## A

### about versus on

When a cross-reference includes information that describes what the cross-reference is to, use *about* instead of *on*.

✓ **Recommended:** For more information about product plans, see Product plans.

⛔️ **Not recommended:** For more information on product plans, see Product plans.

### above

- Don't use for a range of version numbers. Instead, use *later*.

  ⛔️ **Not recommended:** This feature is available in version 5.0 and above.

  ✓ **Recommended:** This feature is available in version 5.0 and later.

- Don't use to refer to a position in a document. Instead, use *earlier* or *preceding*.

  ⛔️ **Not recommended:** See the section above for more details.

  ✓ **Recommended:** See the preceding section for more details.

- Don't use to refer to a position in the UI. Instead, write instructions that avoid directional language.

  ⛔️ **Not recommended:** Click the button above to proceed.

  ✓ **Recommended:** Click the **Proceed** button.

- It's OK to use *above* in a non-directional way, such as when describing a hierarchy.

  ✓ **Recommended:** In the hierarchy, the parent class sits above the child class.

### access (verb)

Avoid when you can. Instead, use friendlier words like *see*, *edit*, *find*, *use*, or *view*.

⛔️ **Not recommended:** Access the settings to change your preferences.

✓ **Recommended:** Open the settings to change your preferences.

### admin

Write out *administrator* unless it's the name of a UI label or other element.

⛔️ **Not recommended:** Contact your admin for assistance.

✓ **Recommended:** Contact your administrator for assistance.

### aka

Don't use. Instead, write out *also known as*, or present an alternative term using parentheses or the word *or*. You can also write out a definition.

✓ **Recommended:** Geographic data, also known as geospatial data, is ...

✓ **Recommended:** Geographic data (geospatial data) is ...

✓ **Recommended:** Geographic data, or geospatial data, is ...

### allows you to

Don't use. Instead, use *lets you*.

⛔️ **Not recommended:** This feature allows you to create custom reports.

✓ **Recommended:** This feature lets you create custom reports.

### and/or

Don't use unless space is limited, such as in a table.

⛔️ **Not recommended:** Install the package on Windows and/or Linux systems.

✓ **Recommended:** Install the package on Windows or Linux systems.

### and so on, etc.

Avoid using *and so on* whenever possible. Provide the full list of items instead.

⛔️ **Not recommended:** The software can process images, videos, and so on.

✓ **Recommended:** The software can process images and videos.

## C

### can

Use *can* in the following ways:

- To convey permission (for example, "You can access the server").
- To refer to an optional action (for example, "You can also view logs with the Log Viewer").
- To describe a possible outcome (for example, "The process can take 30 minutes").

### could

Avoid using. Instead, use *can* where possible.

⛔️ **Not recommended:** This could cause errors in your application.

✓ **Recommended:** This can cause errors in your application.

## E

### e.g.

Don't use. Instead, use phrases like *for example* or *such as*. Many people confuse *e.g.* and *i.e.*

⛔️ **Not recommended:** Use a secure protocol (e.g., HTTPS).

✓ **Recommended:** Use a secure protocol, such as HTTPS.

### enable

In procedures, use the appropriate label and action for the UI element that the user interacts with. When describing a user action or the state of a UI element, use a more precise term where possible. It's OK to use *enable* when not referring to a person.

For turning on or activating an option or feature, use *enable* or *turn on* consistently:

- Use the same term in introductory text as described in the procedure.
- Use the same term throughout the document unless there's a difference in the UI elements for different procedures.

✓ **Recommended:** To enable the API, click the toggle.

✓ **Recommended:** Enable the API for your project.

For making it feasible to do something, use *lets you*.

✓ **Recommended:** The API lets you detect features in images.

⛔️ **Not recommended:** The API enables you to detect features in images.

⛔️ **Not recommended:** The API allows you to detect features in images.

### email

Not *e-mail*, *Email*, or *E-mail*.

⛔️ **Not recommended:** Send an E-mail to support.

✓ **Recommended:** Send an email to support.

### endpoint

Not *end point*.

⛔️ **Not recommended:** Connect to the end point to retrieve data.

✓ **Recommended:** Connect to the endpoint to retrieve data.

### etc.

Avoid using *etc.*, *and so forth*, and *and so on* wherever possible. If you really need to use one, use *etc.* Always include the period, even if a comma follows immediately after.

✓ **Recommended:** Your app might experience problems such as instability or high latency.

✓ **Recommended:** Your app might experience problems, including instability or high latency.

⛔️ **Not recommended:** Your app might experience instability, high latency, and so on.

⛔️ **Not recommended:** Your app might experience instability, high latency, etc.

⛔️ **Not recommended:** If your app experiences instability, high latency, etc., follow these steps:

### extract

Use instead of *unarchive* or *uncompress*.

⛔️ **Not recommended:** Unzip the file to access the contents.

✓ **Recommended:** Extract the file to access the contents.

## F

### fill in; fill out

Use *fill in* when referring to entering information in individual fields.

Use *fill out* when referring to completing an entire form.

✓ **Recommended:** Fill out the questionnaire. Be sure to fill in the required fields.

### foo

Avoid when possible even though it's a common term in the developer community. Instead, use a clearer and more meaningful placeholder name.

⛔️ **Not recommended:** Replace `foo` with your project name.

✓ **Recommended:** Replace `PROJECT_ID` with your project name.

## H

### he, she, his, her, hers

Don't use a gendered pronoun except for a specific individual of known gender. Use *they* and *their* for the general singular pronoun.

⛔️ **Not recommended:** Each user should update his password regularly.

✓ **Recommended:** Each user should update their password regularly.

### hover over

Don't use; use *hold the pointer over* instead.

Only use the *hold the pointer over* verb phrase in the following cases:

- When the user needs to hold their mouse over a UI element, but not click the UI element. This action involves waiting for the UI to react—for example, waiting for a tooltip to open or waiting for a submenu to open.
- When the duration of time is important.

The phrase *point to* is more common.

✓ **Recommended:** In the **Admin** menu, hold the pointer over **File**, and then click **New**.

⛔️ **Not recommended:** In the **Admin** menu, hover over **File**, and then click **New**.

## I

### i.e.

Don't use. Instead, use phrases like *that is*. Many people confuse *e.g.* and *i.e.*

⛔️ **Not recommended:** The API supports one protocol (i.e., gRPC).

✓ **Recommended:** The API supports one protocol—that is, gRPC.

### in order to

Avoid *in order to*; instead, use *to*.

Use *in order to* when needed to clarify meaning or to make something easier to read.

✓ **Recommended:** You can use monitoring to help identify issues.

⛔️ **Not recommended:** You can use monitoring in order to help identify issues.

✓ **Recommended:** The infrastructure is required to support search.

⛔️ **Not recommended:** The infrastructure is required in order to support search.

## L

### latest

Avoid in timeless documentation because this word can become outdated.

If you must use *latest*, give the reader a reference point—for example, a version number or release date.

✓ **Recommended:** To help keep your system secure, install the latest version of the tools.

✓ **Recommended:** The June 1, 2021 release includes the latest tools that help secure your system.

⛔️ **Not recommended:** The product includes the latest tools that help secure your system.

### lower

- Don't use for a range of version numbers. Instead, use *earlier*.

  ⛔️ **Not recommended:** This feature is available in version 3.0 and lower.

  ✓ **Recommended:** This feature is available in version 3.0 and earlier.

- Don't use to refer to a position in a document. Instead, use *later* or *following*.

  ⛔️ **Not recommended:** See the table in the lower section for details.

  ✓ **Recommended:** See the table in the following section for details.

- Don't use to refer to a position in the UI. Instead, write instructions that avoid directional language.

  ⛔️ **Not recommended:** Click the button in the lower-left corner.

  ✓ **Recommended:** Click the **Start** button.

## M

### may

In general, reserve for official policy or legal considerations.

To convey possibility, use *can* or *might* instead.

To convey permission, use *can* instead.

⛔️ **Not recommended:** You may experience delays during peak hours.

✓ **Recommended:** You might experience delays during peak hours.

### might

Use to convey possibility or an uncertain outcome (for example, "You might be prompted to enter your credentials").

### must

Use to describe a required action or state (for example, "You must have the Editor role"). You can also write *you need* in order to convey a requirement.

## N

### new, newer

Avoid in timeless documentation because this word can become outdated.

*New* also implies that the reader knows the older product and that labeling something as new is therefore meaningful.

If you must use *new*, give the reader a reference point—for example, a version number or release date.

Don't use *newer* to refer to a specific version of a product. Instead, use *later*. Make sure that you provide a version number or release date by which to understand *later*.

⛔️ **Not recommended:** The new interface improves user experience.

✓ **Recommended:** The interface introduced in version 2.0 improves user experience.

## O

### old, older

Don't use to refer to a previous version of a product. Instead, use *earlier*.

Make sure that you provide a version number by which to understand *earlier*.

⛔️ **Not recommended:** This feature is not available in older versions.

✓ **Recommended:** This feature is not available in version 2.0 or earlier.

### once

If you mean *after*, then use *after* instead of *once*.

⛔️ **Not recommended:** Once the installation is complete, restart your computer.

✓ **Recommended:** After the installation is complete, restart your computer.

## P

### pane

Do not use terms such as _panel_, _section_, _area_, or _column_ to refer to a _pane_.

✓ **Recommended:** In the **Create service account** pane, click **New**.

⛔️ **Not recommended:** In the **Create service account** panel, click **New**.

### per

To express a rate, use *per* instead of the division slash (/), unless space constraints require the use of the slash.

Avoid *per* in contexts other than rate units.

✓ **Recommended:** requests per day

✓ **Recommended:** in response to your request

⛔️ **Not recommended:** requests/day

⛔️ **Not recommended:** as per your request

### please

Don't use *please* in the normal course of explaining how to use a product, even if you're explaining a difficult task.

Don't use the phrase *please note*.

Use *please* only when you're asking for permission or forgiveness—for example, when what you're asking for benefits you, inconveniences a reader, or suggests a potential issue with a product.

✓ **Recommended:** If the issue persists, please contact your account representative.

### point to

Use to refer to the action of pointing the mouse pointer (focus). This action doesn't imply a length of time waiting for the UI to react to user action.

⛔️ **Not recommended:** Hover over the menu item and click.

✓ **Recommended:** Point to the menu item and click.

### possible

Don't use *possible* or *impossible* to mean you can or you can't.

⛔️ **Not recommended:** It's impossible to edit the file.

✓ **Recommended:** You can't edit the file.

### press

Use when referring to pressing a key or a key combination to cause an action to occur. Also use for mechanical buttons.

For on-screen and soft (capacitive) buttons, use *tap*.

✓ **Recommended:** Press Control+C (or Command+C on macOS).

### pros

Don't use. Instead, use a more precise term, such as *advantages*.

⛔️ **Not recommended:** Let's consider the pros and cons of this approach.

✓ **Recommended:** Let's consider the advantages and disadvantages of this approach.

## R

### repo

Don't use. Instead, use *repository*.

⛔️ **Not recommended:** Clone the repo to your local machine.

✓ **Recommended:** Clone the repository to your local machine.

## S

### should, should be

Generally avoid.

Because *should* is ambiguous by definition, it can be problematic. For example, if you're telling the reader what to do, *should* implies that the action is recommended but optional, which can leave the reader unsure about what to do.

Clarify what you mean. Determine if an action is required versus optional, an outcome is expected versus possible, or a state is actual versus recommended.

If an action is required: Use *must*, or rephrase the sentence so that it's a clear imperative instruction such as "Do the following before you continue."

If an action is recommended: Use *We recommend...* or *Google recommends...*. You can use *should* if a recommended action is generally recognized. For example, "You should use a strong password..." or "You should follow the principle of least privilege...."

If an action is optional: Use *can*. For example, "You can also use approach B to solve the same problem."

If an outcome is expected: Describe the outcome in terms of what is expected. For example: "The process returns 10 items."

If an outcome is possible: Use *might* or *can*. For example, "The process can take about 30 minutes."

If a state is actual: When you're describing the state of something, such as the value of a variable, avoid writing "The value should be true." Instead, clarify which of the following you mean:

- "You must set the value to true."
- "The server sets the value to true."
- "If the value is false, follow these steps to change it to true."

### soon

Avoid in timeless documentation because this word can become outdated. The word can also prematurely disclose product or feature strategy or inappropriately imply that a product or feature might change.

See also *eventually* and *future*.

✓ **Recommended:** This setting is optional.

⛔️ **Not recommended:** This setting is optional for existing applications but will soon be required for all applications.

## T

### type

In general, use *enter* instead of *type* because there is typically more than one way to enter text than typing (such as pasting text or speaking).

⛔️ **Not recommended:** Type your username and password to log in.

✓ **Recommended:** Enter your username and password to log in.

## U

### under

- Don't use for a range of version numbers. Instead, use *earlier*.

  ⛔️ **Not recommended:** This feature is available in version 2.0 and under.

  ✓ **Recommended:** This feature is available in version 2.0 and earlier.

- Don't use to refer to a position in the UI.

  ⛔️ **Not recommended:** Under **Options**, select **Settings**.

  ✓ **Recommended:** In the **Options** menu, select **Settings**.

### unzip

Don't use. Instead, use *extract*.

⛔️ **Not recommended:** Unzip the files to a new folder.

✓ **Recommended:** Extract the files to a new folder.

### utilize

Use with caution. Don't use *utilize* when you mean *use*. It's OK to use *utilize* or *utilization* when referring to the quantity of a resource being used.

✓ **Recommended:** When CPU utilization exceeds 75%, the autoscaler adds more CPU resources.

✓ **Recommended:** To distribute network traffic, use a load balancer.

⛔️ **Not recommended:** To distribute network traffic, utilize a load balancer.

## V

### via

Don't use.

⛔️ **Not recommended:** Send the report via email.

✓ **Recommended:** Send the report by email.

### vice versa

Don't use. Instead, use a phrase like *the other way around*, *conversely*, or *otherwise*. In some contexts, *vice versa* is unclear or imprecise because in a complex sentence it's hard to know which two things are swapped with each other. In such cases, make it explicitly clear what two things are swapped.

⛔️ **Not recommended:** You can convert from JPEG to PNG, and vice versa.

✓ **Recommended:** You can convert between JPEG and PNG formats.

### vs.

Don't use *vs.* as an abbreviation for *versus*; instead, use the unabbreviated *versus*.

⛔️ **Not recommended:** This guide compares Java vs. Kotlin.

✓ **Recommended:** This guide compares Java versus Kotlin.

## W

### we

Don't use *we* (or other first-person plural pronouns such as *our* or *us*) to address the reader who is performing the tasks that you're documenting. Instead, use *you*.

It's OK to use *we* to refer to the organization that's represented as the author of the document as long as the antecedent is clear.

⛔️ **Not recommended:** In this section, we will show you how to configure the server.

✓ **Recommended:** This section shows you how to configure the server.

### will

Avoid. Applies equally to its past tense, *would*.

⛔️ **Not recommended:** The system will generate a report.

✓ **Recommended:** The system generates a report.

### wish

Don't use. Instead, use a word like *want* or *need*.

⛔️ **Not recommended:** If you wish to proceed, click **Next**.

✓ **Recommended:** If you want to proceed, click **Next**.

### would

Avoid using. Instead, use *can* where possible.

⛔️ **Not recommended:** This would help improve performance.

✓ **Recommended:** This can help improve performance.

## Y

### you

Use *you* instead of *user* to address the reader of your document.

⛔️ **Not recommended:** The user can access their profile settings.

✓ **Recommended:** You can access your profile settings.