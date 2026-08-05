---
title: Edit links
description: Learn how to edit links in WellFunnel Builder
last_update: 
  date: 3/25/2025
---

This document shows how to edit [links](/docs/wellfunnel-builder/links/links-overview).

## Prerequisites

Before you start, read the [reference information](#reference-information-edit-a-link) or look up the necessary descriptions as you go through the process.

## Edit a link

Navigate to the **Links** page, and for the link you want to edit, click <Icon icon="ic:sharp-edit" height="24" style={{ color: '#9564ff' }} /> **Edit**. This opens the link editing page.

The link editing process consists of two steps:

* **Edit link information**: On the link editing page, update the information about the link.
* **Edit flows**: Modify existing flows and add new ones.

### Edit link information

In the **Link** section, edit link details:
1. For **Experiment**, enter a name for the experiment.
2. To define where to split the traffic, from **Split traffic**, select either **Onboarding** or **Payment**.
3. Optional: In **Confluence**, enter a link to the document describing the link in Confluence.
4. Optional: In **Description**, add a description for the link.
5. From **Platform**, select the platform the link is meant for.
6. To make the link universal, switch **Universal link** to the on position. We recommend creating or assigning a unique branch for the universal link to avoid unintended changes in other branches.

![Link editing: Link section](./.assets/link-editing-page-link-section.png)

### Edit flows and add screens

:::note

The **Flow details** section displays settings for each flow. When you add multiple flows, you can adjust details for each one separately.

When **Payment** is selected for **Split traffic mode**, onboarding screens can't be edited during flow configuration.  
This ensures changes don't affect the validity of the traffic split and test results. Refer to [Resplit logic](/docs/wellfunnel-builder/links/links-overview.md#split-traffic-mode-parameter) for more details.

:::

To edit flows, follow these steps:

1. Edit existing flows:
   1. Click the flow you want to change.
   2. In the **Split traffic** field of the flow, change its value to `0`. To change the traffic percentage of one flow, you must have at least two flows available for redistributing the traffic.
   3. To remove existing screens or add new ones, in the **Onboarding** and **Payment** sections, use the <Icon icon="ic:baseline-minus" height="24" style={{ color: '#868686' }} />**Remove** and <Icon icon="ic:baseline-plus" height="24" style={{ color: '#868686' }} />**Add screen** buttons.
   4. For **Flow name**, enter a new name for the flow.
2. Add new flows:
   1. To create a new flow, copy one of the existing flows by clicking <Icon icon="clarity:copy-line" height="24" style={{ color: '#868686' }} />**Copy**. This creates a new flow named `Variant_`*`SEQUENCE_LETTER`* with 0% traffic allocation. You can rename added flows as needed.
   2. To remove existing screens or add new ones, in the **Onboarding** and **Payment** sections, use the <Icon icon="ic:baseline-minus" height="24" style={{ color: '#868686' }} />**Remove** and <Icon icon="ic:baseline-plus" height="24" style={{ color: '#868686' }} />**Add screen** buttons.
3. For each flow, in **Split traffic**, set the split traffic values so that all flows have 100% of the traffic in total.

![Link creation: Flows, Onboarding, and Payment sections](./.assets/link-editing-flows-onboarding-and-payment-sections.png)

4. Adjust flow details for each flow:
   1. Click the flow you want to adjust.
   2. In the **Flow details** section, from **Theme**, select a theme you want to apply to the flow.
   3. From **Payment**, select a payment provider you want to use within the flow.

![Link editing: Flow details section](./.assets/link-editing-flow-details-section.png)

5. To save changes, click <Icon icon="material-symbols:save" height="18" style={{ color: '#868686' }} />**SAVE**.

## Reference information: Edit a link

| Attribute | Description |
|---|---|
| Link: ID | Unique identifier for the link. |
| Link: Experiment | Name of the experiment associated with the link. For more details, see [Experiment name and its usage for analytics](/docs/wellfunnel-builder/links/links-overview#experiment-name-and-its-usage-for-analytics). |
| Link: Project | [Project](/docs/wellfunnel-builder/projects/projects-overview.md) associated with the link. |
| Link: Branch | [Branch](/docs/wellfunnel-builder/branches/branches-overview.md) tied to the link. The default flow is based on the flow configured in the selected branch. |
| Link: Split traffic | Determines the split point for traffic: <ul><li>**Onboarding**: Divides traffic between onboarding flows and directs it to respective payment flows.</li><li>**Payment**: Divides traffic between payment flows only.</li></ul> For more details, see [Resplit logic](/docs/wellfunnel-builder/links/links-overview.md#resplit-logic). |
| Link: Confluence | Optional field for a Confluence document link describing the link. |
| Link: Description | Internal description of the link in WellFunnel Builder. |
| Link: Platform | Specifies the platform for the link: <ul><li>**Web**: For laptops or desktops.</li><li>**Mobile**: For mobile phones or tablets.</li></ul> |
| Link: Universal link | Marks the link as universal for the project. If enabled, any existing universal link becomes a standard link. For more details, see [Universal link logic](/docs/wellfunnel-builder/links/links-overview#universal-link-logic). |
| Flow details: Theme | Theme applied to the flow. Themes are project-specific. For example, if your project is Fasting, only Fasting-related themes are shown. For more details, see [Theme application at flow level](/docs/wellfunnel-builder/links/links-overview#theme-application-at-flow-level). |
| Flow details: Payment | Payment provider for the flow: **Solidgate** or **Inary**. Note: **Solidgate** is the default selection for existing flows and cannot be changed. |
| Flows: Flow name | Unique name for each flow. Flows copied from the default are named `Variant_`*`SEQUENCE_LETTER`*. For example, the first copied flow is named `Variant_A`. You can rename both the default and copied flows. |
| Flows: Split traffic | Lets you set a percentage of total traffic allocation for the flow. |
| Onboarding | Section containing screens for the onboarding part of the flow. Only screens linked to the selected project are available. |
| Payment | Section containing the payment part of the flow. Only screens linked to the selected project are available. |

## Next steps

* [Copy links](/docs/wellfunnel-builder/links/manage-in-wellfunnel/copy-links)
* [Delete links](/docs/wellfunnel-builder/links/manage-in-wellfunnel/delete-links)
* [View link details](/docs/wellfunnel-builder/links/manage-in-wellfunnel/view-link-details)
* [View link audit logs](/docs/wellfunnel-builder/links/manage-in-wellfunnel/view-link-audit-logs)
