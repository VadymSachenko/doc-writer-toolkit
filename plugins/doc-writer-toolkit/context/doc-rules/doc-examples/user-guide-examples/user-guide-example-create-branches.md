---
title: Create branches
description: Learn how to create branches in WellFunnel Builder
last_update: 
  date: 5/29/2024
---

This document shows you how to create branches.

Branch creation involves several steps:
1. **Entering branch details**: On the **INFO** tab, you need to define the URL part, associate a theme, and set the branch as default if required.
2. **Configuring screen settings**: On the **SCREENS** tab, you need to create a flow by adding required [screens](/docs/wellfunnel-builder/screens/screens-overview.md) to the onboarding and payment parts.

## Prerequisites

Before you start, read the [reference information](#reference-information-create-a-branch), or look up the necessary descriptions as you go through the process.

## Enter branch details

1. Navigate to the **Branches** page and click **+CREATE NEW**.

![Branches page: Create new button](./.assets/branches-page-create-new-button.png)

2. On the **Create new branch** page that opens, on the **INFO** tab, enter and select the necessary values:
   * From **Project**, select the project to assign the branch to.
   * For **URL segment**, enter a part of the URL that users may see.
   * From **Theme**, apply the desired theme for all links related to this branch.
   * For **Description**, enter a description of the branch's purpose.
   * Optional: To indicate that this branch is the default for the project, switch the **Default branch** toggle to the on position.

      :::warning

      Toggling on **Default branch** removes the default status from any other branch that previously had it.

      :::

      ![Create new branch page: Info tab](./.assets/create-new-branch-page-info-tab.png)

## Configure screen settings

1. To set up the branch flow with the necessary screens, move to the **SCREENS** tab.
2. Add screens to the onboarding part of the flow:
   1. In the **Onboarding part** section, click the **Add+** button.
   2. In the box that appears, enter the onboarding screen key and select the necessary one from the search results.
   3. To add multiple onboarding screens, repeat steps 2.1-2.2.

    :::info

    To adjust screen sequence in the flow, drag screens up and down using the <Icon icon="material-symbols:drag-indicator" height="24" style={{ color: 'grey' }} /> **Drag me!** button.

    To delete a redundant screen, click <Icon icon="mdi:delete-forever" height="24" style={{ color: '#ec5152' }} /> **Delete**.

    :::

3. Add screens to the payment part of the flow:
   1. In the **Payment part** section, click **Add+**.
   2. In the box that appears, enter the payment screen key and select the necessary one from the search results.
   3. To add multiple onboarding screens, repeat steps 3.1-3.2.

   ![Create new branch page: Screens tab](./.assets/create-new-branch-page-screens-tab.png)

:::warning

WellFunnel *doesn't* notify you about conflicts between screens you add. Therefore, you must understand each screen's function and thoroughly test the flow before using it in marketing.

:::

4. To save the branch, click **Save**. The "Branch has been successfully created" notification is displayed, and the new branch appears on the **Branches** page as the first item in the list.

:::info

You *can't* test a branch independently; it *must* be tested through link creation. For this, when generating links, include the branch flow.

To simulate [Plan B](/docs/wellfunnel-builder/branches/branches-overview.md#wellfunnel-contingency-plans), in the URL, replace the real value of the `link-id` parameter with an invalid one.

:::

## Reference information: Create a branch

This section describes the attributes you define when creating a branch.

### Info tab

| Attribute | Description |
|---|---|
| Project | [Project](/docs/wellfunnel-builder/projects/projects-overview.md) that the branch will be related to. Each branch must be associated with a specific project. |
| URL segment | Part of the URL visible to users. |
| Theme | [Theme](/docs/wellfunnel-builder/themes/themes-overview.md) applied to the branch. Any theme can be associated with any branch. |
| Description | Branch purpose description. |
| Default branch | Indicates whether the branch is the default for the associated project, corresponding to [Plan C](/docs/wellfunnel-builder/branches/branches-overview.md#wellfunnel-contingency-plans) in the system. |

### Screens tab

| Attribute | Description |
|---|---|
| Onboarding part | Screens related to the onboarding part of the flow. You can only assign screens related to the selected project. Available screens depend on the project selected on the **INFO** tab. |
| Payment part | Screens related to the payment part of the flow. You can only assign screens related to the selected project. Available screens depend on the project selected on the **INFO** tab. |

## Next steps

* [Copy branches](/docs/wellfunnel-builder/branches/manage-in-wellfunnel/copy-branches)
* [Edit branches](/docs/wellfunnel-builder/branches/manage-in-wellfunnel/edit-branches)
* [View branch audit logs](/docs/wellfunnel-builder/branches/manage-in-wellfunnel/view-branch-audit-logs)