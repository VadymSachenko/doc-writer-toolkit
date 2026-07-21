---
title: "Glue API: Manage guest carts"
description: Retrieve details about guest carts and learn what else you can do with the resource.
last_update:
  date: 2/22/2026
---

This endpoint lets you manage guest carts.

## Installation

For detailed information on the modules that provide the API functionality and related installation instructions, see:

* [Install the Cart Glue API](/docs/pbc/all/cart-and-checkout/latest/base-shop/install-and-upgrade/install-glue-api/install-the-cart-glue-api.md)
* [Install the Promotions & Discounts feature Glue API](/docs/pbc/all/discount-management/latest/base-shop/install-and-upgrade/install-features/install-the-promotions-and-discounts-glue-api.md)
* [Install the Product Options Glue API](/docs/pbc/all/product-information-management/latest/base-shop/install-and-upgrade/install-glue-api/install-the-product-options-glue-api.md)
* [Install the Product Labels Glue API](/docs/pbc/all/product-information-management/latest/base-shop/install-and-upgrade/install-glue-api/install-the-product-image-sets-glue-api.md)

## Create a guest cart

To create a guest cart as an unauthenticated user, [add items to a guest cart](/docs/pbc/all/cart-and-checkout/latest/base-shop/manage-using-glue-api/manage-guest-carts/glue-api-manage-guest-cart-items.md#add-items-to-a-guest-cart).

## Retrieve a guest cart

To retrieve a guest cart, send the request:

---

`GET /guest-carts`

---

:::info["Guest cart ID"]

Guest users have one guest cart by default. If you already have a guest cart, you can optionally specify its ID when adding items. To do that, use the following endpoint. The information in this section is valid for both of the endpoints.

`GET /guest-carts/{guestCartId}`

| Path parameter | Description |
| --- | --- |
| `{guestCartId}` | Unique identifier of the guest cart. To get it, [retrieve a guest cart](#retrieve-a-guest-cart). |

:::

:::warning

When retrieving the cart with `guestCartId`, the response includes a single object, and when retrieving the resource without specifying it, you get an array containing a single object.

:::

### Request

| Header key | Header value example | Required | Description |
| --- | --- | --- | --- |
| `X-Anonymous-Customer-Unique-Id` | `164b-5708-8530` | ✓ | Guest user's unique identifier. For security purposes, we recommend passing a hyphenated alphanumeric value, but you can pass any. If you are sending automated requests, you can configure your API client to generate this value. |

| Query parameter | Description | Possible values |
| --- | --- | --- |
| `include` | Adds resource relationships to the request. | `guest-cart-items`, `cart-rules`, `promotional-items`, `gift-cards`, `vouchers`, `product-options`, `sales-units`, `product-measurement-units`, `product-labels` |

:::info["Included resources"]

* To retrieve product options, include `guest-cart-items`, `concrete-products`, and `product-options`.
* To retrieve product measurement units, include `sales-units` and `product-measurement-units`.
* To retrieve product labels assigned to the products in a cart, include `concrete-products` and `product-labels`.

:::

| Request | Usage |
| --- | --- |
| `GET https://glue.mysprykershop.com/guest-carts` | Retrieve a guest cart. |
| `GET https://glue.mysprykershop.com/guest-carts?include=guest-cart-items` | Retrieve information about a guest cart with the concrete products included. |
| `GET https://glue.mysprykershop.com/guest-carts?include=cart-rules` | Retrieve a guest cart with information about the cart rules. |
| `GET https://glue.mysprykershop.com/guest-carts?include=gift-cards,vouchers` | Retrieve a guest cart with information about the gift cards applied. |
| `GET https://glue.mysprykershop.com/guest-carts?include=guest-cart-items,concrete-products,product-options` | Retrieve a guest cart with information about its items, respective concrete products, and product options of the concrete products. |
| `GET https://glue.mysprykershop.com/guest-carts?include=sales-units,product-measurement-units` | Retrieve a guest cart with information about its items, sales units, and product measurement units. |
| `GET https://glue.mysprykershop.com/guest-carts?include=vouchers` | Retrieve a guest cart with information about vouchers. |
| `GET https://glue.mysprykershop.com/guest-carts?include=concrete-products,product-labels` | Retrieve a guest cart with information about concrete products and the product labels assigned to the products in it. |

### Response

<details>
<summary>Response sample: retrieve a guest cart</summary>

```json
{
    "data": [
        {
            "type": "guest-carts",
            "id": "f8782b6c-848d-595e-b3f7-57374f1ff6d7",
            "attributes": {
                "priceMode": "GROSS_MODE",
                "currency": "EUR",
                "store": "DE",
                "name": "Shopping cart",
                "isDefault": true,
                "totals": {
                    "expenseTotal": 0,
                    "discountTotal": 10689,
                    "taxTotal": 15360,
                    "subtotal": 106892,
                    "grandTotal": 96203,
                    "priceToPay": 93203
                },
                "discounts": [...],
                "thresholds": []
            },
            "links": {...}
        }
    ],
    "links": {...}
}
```

</details>

<details>
<summary>Response sample: retrieve a guest cart with the items included</summary>

```json
{
    "data": [
        {
            "type": "guest-carts",
            "id": "f8782b6c-848d-595e-b3f7-57374f1ff6d7",
            "attributes": {...},
            "links": {...},
            "relationships": {
                "guest-cart-items": {
                    "data": [{"type": "guest-cart-items", "id": "023_21758366"}]
                }
            }
        }
    ],
    "links": {...},
    "included": [
        {
            "type": "guest-cart-items",
            "id": "023_21758366",
            "attributes": {
                "sku": "023_21758366",
                "quantity": "4",
                "groupKey": "023_21758366",
                "abstractSku": "023",
                "amount": null,
                "productOfferReference": null,
                "merchantReference": null,
                "calculations": {
                    "unitPrice": 26723,
                    ...
                },
                "salesUnit": null,
                "selectedProductOptions": []
            },
            "links": {...}
        }
    ]
}
```

</details>

<details>
<summary>Response sample: retrieve a guest cart with cart rules included</summary>

```json
{
    "data": [
        {
            "type": "guest-carts",
            "id": "f8782b6c-848d-595e-b3f7-57374f1ff6d7",
            "attributes": {...},
            "links": {...},
            "relationships": {
                "cart-rules": {
                    "data": [{"type": "cart-rules", "id": "1"}]
                }
            }
        }
    ],
    "links": {...},
    "included": [
        {
            "type": "cart-rules",
            "id": "1",
            "attributes": {
                "amount": 10689,
                "code": null,
                "discountType": "cart_rule",
                "displayName": "10% Discount for all orders above",
                "isExclusive": false,
                "expirationDateTime": "2020-12-31 00:00:00.000000",
                "discountPromotionAbstractSku": null,
                "discountPromotionQuantity": null
            },
            "links": {...}
        }
    ]
}
```

</details>

<details>
<summary>Response sample: add items with gift cards to a guest cart</summary>

```json
{
    "data": [
        {
            "type": "guest-carts",
            "id": "f8782b6c-848d-595e-b3f7-57374f1ff6d7",
            "attributes": {...},
            "links": {...},
            "relationships": {
                "gift-cards": {
                    "data": [{"type": "gift-cards", "id": "GC-Z9FYJRK3-20"}]
                }
            }
        }
    ],
    "links": {...},
    "included": [
        {
            "type": "gift-cards",
            "id": "GC-Z9FYJRK3-20",
            "attributes": {
                "code": "GC-Z9FYJRK3-20",
                "name": "Gift Card 30",
                "value": 3000,
                "currencyIsoCode": "EUR",
                "actualValue": 3000,
                "isActive": true
            },
            "links": {...}
        }
    ]
}
```

</details>

<details>
<summary>Response sample: retrieve a guest cart with items, respective concrete products, and their product options included</summary>

```json
{
    "data": [
        {
            "type": "guest-carts",
            "id": "7e42298e-9f15-5105-a192-96726a2b9da8",
            "attributes": {...},
            "links": {...},
            "relationships": {
                "guest-cart-items": {
                    "data": [{"type": "guest-cart-items", "id": "181_31995510-3-5"}]
                }
            }
        }
    ],
    "links": {...},
    "included": [
        {
            "type": "product-options",
            "id": "OP_1_year_waranty",
            "attributes": {
                "optionGroupName": "Warranty",
                "sku": "OP_1_year_waranty",
                "optionName": "One (1) year limited warranty",
                "price": 0,
                "currencyIsoCode": "EUR"
            },
            "links": {...}
        },
        {
            "type": "concrete-products",
            "id": "181_31995510",
            "attributes": {...},
            "links": {...},
            "relationships": {
                "product-options": {
                    "data": [...]
                }
            }
        },
        {
            "type": "guest-cart-items",
            "id": "181_31995510-3-5",
            "attributes": {
                "sku": "181_31995510",
                "quantity": "4",
                "groupKey": "181_31995510-3-5",
                "abstractSku": "181",
                "amount": null,
                "productOfferReference": null,
                "merchantReference": null,
                "calculations": {...},
                "configuredBundle": null,
                "configuredBundleItem": null,
                "salesUnit": null,
                "selectedProductOptions": [
                    {
                        "optionGroupName": "Gift wrapping",
                        "sku": "OP_gift_wrapping",
                        "optionName": "Gift wrapping",
                        "price": 2000
                    }
                ]
            },
            "links": {...},
            "relationships": {
                "concrete-products": {
                    "data": [{"type": "concrete-products", "id": "181_31995510"}]
                }
            }
        }
    ]
}
```

</details>

<details>
<summary>Response sample: retrieve a guest cart with its items, sales units, and product measurement units</summary>

```json
{
    "data": [
        {
            "type": "guest-carts",
            "id": "5cc8c1ad-a12a-5a93-9c6e-fd4bc546c81c",
            "attributes": {...},
            "links": {...}
        }
    ],
    "links": {...},
    "included": [
        {
            "type": "product-measurement-units",
            "id": "METR",
            "attributes": {"name": "Meter", "defaultPrecision": 100},
            "links": {...}
        },
        {
            "type": "sales-units",
            "id": "33",
            "attributes": {
                "conversion": 1,
                "precision": 100,
                "isDisplayed": true,
                "isDefault": true,
                "productMeasurementUnitCode": "METR"
            },
            "links": {...},
            "relationships": {
                "product-measurement-units": {
                    "data": [{"type": "product-measurement-units", "id": "METR"}]
                }
            }
        },
        {
            "type": "guest-cart-items",
            "id": "cable-vga-1-2_quantity_sales_unit_id_33_amount_1.5_sales_unit_id_33",
            "attributes": {
                "sku": "cable-vga-1-2",
                "quantity": 3,
                "groupKey": "cable-vga-1-2_quantity_sales_unit_id_33_amount_1.5_sales_unit_id_33",
                "abstractSku": "cable-vga-1",
                "amount": "4.5",
                "productOfferReference": null,
                "merchantReference": null,
                "calculations": {...},
                "configuredBundle": null,
                "configuredBundleItem": null,
                "salesUnit": {"id": 33, "amount": "4.5"},
                "selectedProductOptions": []
            },
            "links": {...},
            "relationships": {
                "sales-units": {
                    "data": [{"type": "sales-units", "id": "33"}]
                }
            }
        }
    ]
}
```

</details>

<details>
<summary>Response sample: retrieve a guest cart with a cart rule and a discount voucher</summary>

```json
{
    "data": {
        "type": "guest-carts",
        "id": "1ce91011-8d60-59ef-9fe0-4493ef3628b2",
        "attributes": {...},
        "links": {...},
        "relationships": {
            "vouchers": {
                "data": [
                    {
                        "type": "vouchers",
                        "id": "mydiscount-yu8je"
                    }
                ]
            },
            "cart-rules": {
                "data": [
                    {
                        "type": "cart-rules",
                        "id": "1"
                    }
                ]
            }
        }
    },
    "included": [
        {
            "type": "vouchers",
            "id": "mydiscount-yu8je",
            "attributes": {
                "amount": 49898,
                "code": "mydiscount-yu8je",
                "discountType": "voucher",
                "displayName": "My Discount",
                "isExclusive": false,
                "expirationDateTime": "2020-02-29 00:00:00.000000",
                "discountPromotionAbstractSku": null,
                "discountPromotionQuantity": null
            },
            "links": {...}
        },
        {
            "type": "cart-rules",
            "id": "1",
            "attributes": {...},
            "links": {...}
        }
    ]
}
```

</details>

<details>
<summary>Response sample: retrieve a guest cart with product labels included</summary>

```json
{
    "data": [
        {
            "type": "guest-carts",
            "id": "4f3e67f7-f18c-55ad-8297-2e09b80cf3ff",
            "attributes": {...},
            "links": {...}
        }
    ],
    "links": {...},
    "included": [
        {
            "type": "product-labels",
            "id": "5",
            "attributes": {
                "name": "SALE %",
                "isExclusive": false,
                "position": 3,
                "frontEndReference": "highlight"
            },
            "links": {...}
        },
        {
            "type": "concrete-products",
            "id": "179_29658416",
            "attributes": {...},
            "links": {...},
            "relationships": {
                "product-labels": {
                    "data": [{"type": "product-labels", "id": "5"}]
                }
            }
        },
        {
            "type": "guest-cart-items",
            "id": "179_29658416",
            "attributes": {...},
            "links": {...},
            "relationships": {
                "concrete-products": {
                    "data": [{"type": "concrete-products", "id": "179_29658416"}]
                }
            }
        }
    ]
}
```

</details>

## Assign a guest cart to a registered customer

Guest carts are anonymous as they are not related to any user. If a user registers or logs in, the guest cart can be automatically assigned to their account.

To assign a guest cart to a customer, for example, merge the carts, include the unique identifier associated with the customer in the `X-Anonymous-Customer-Unique-Id` header of the authentication request if it's an existing customer, or request to create a customer account if it's a new one. Adjust the configuration constant to create a cart for the newly authenticated customer while merging the guest cart with the customer cart:

`src/Pyz/Zed/CartsRestApi/CartsRestApiConfig.php`

```php
<?php

namespace Pyz\Zed\CartsRestApi;

use Spryker\Zed\CartsRestApi\CartsRestApiConfig as SprykerCartsRestApiConfig;

class CartsRestApiConfig extends SprykerCartsRestApiConfig
{
    protected const IS_QUOTE_CREATION_WHILE_QUOTE_MERGING_ENABLED = true;
}
```

Upon login, the behavior depends on whether your project is a single cart or [multiple cart](/docs/pbc/all/cart-and-checkout/latest/base-shop/feature-overviews/multiple-carts-feature-overview.md) environment:

- In a single cart environment, the products in the guest cart are added to the customers' own cart.
- In a multiple cart environment, the guest cart is converted to a regular user cart and added to the list of the customers' own carts.

The workflow is displayed in the following diagram:

{/* TODO: Replace the diagrams.net embed with a supported diagram format, such as Mermaid or a static image. The mxGraph HTML embed and external viewer script are not supported in Docusaurus MDX. */}

The following is an exemplary workflow of converting a guest cart into a regular cart:

1. The customer adds items to a guest cart.

   Request sample:

   `POST https://glue.myspsrykershop.com/guest-cart-items`

   ```json
   {
       "data": {
           "type": "guest-cart-items",
           "attributes": {"sku": "022_21994751", "quantity": 5}
       }
   }
   ```

   | Header key | Header value example | Description |
   | --- | --- | --- |
   | `X-Anonymous-Customer-Unique-Id` | `guest-user-001` | A guest user's unique identifier. For security purposes, we recommend passing a hyphenated alphanumeric value, but you can pass any. If you are sending automated requests, you can configure your API client to generate this value. |

   Response sample:

   ```json
   {
       "data": {
           "type": "guest-carts",
           "id": "9183f604-9b2c-53d9-acbf-cf59b9b2ff9f",
           "attributes": {...},
           "links": {...}
       },
       "included": [...]
   }
   ```

2. The customer logs in.

   Request sample:

   `POST https://glue.myspsrykershop.com/access-tokens`

   ```json
   {
       "data": {
           "type": "access-tokens",
           "attributes": {"username": "john.doe@example.com", "password": "qwerty"}
       }
   }
   ```

   | Header key | Header value example | Description |
   | --- | --- | --- |
   | `X-Anonymous-Customer-Unique-Id` | `guest-user-001` | Guest user's unique identifier. For security purposes, we recommend passing a hyphenated alphanumeric value, but you can pass any. If you are sending automated requests, you can configure your API client to generate this value. |

   Response sample:

   ```json
   {
       "data": {
           "type": "access-tokens",
           "id": null,
           "attributes": {
               "tokenType": "Bearer",
               "expiresIn": 28800,
               "accessToken": "eyJ0eXAiOiJKV1QiLC...",
               "refreshToken": "def50200ae2d0...",
               "idCompanyUser": "94d58692-c117-5466-8b9f-2ba32dd87c43"
           },
           "links": {...}
       }
   }
   ```

3. The customer requests a list of their own carts.

   Request sample:

   `GET https://glue.myspsrykershop.com/carts`

   | Header key | Header value | Required | Description |
   | --- | --- | --- | --- |
   | `Authorization` | `string` | ✓ | Alphanumeric string that authenticates the customer you want to change the password of. Get it by [authenticating as a customer](/docs/pbc/all/identity-access-management/latest/manage-using-glue-api/glue-api-authenticate-as-a-customer.md). |

   In the multiple cart environment, the guest cart has been converted to a regular cart. You can see it in the list of carts with the id `9183f604-9b2c-53d9-acbf-cf59b9b2ff9f`.

   Response sample:

   ```json
   {
       "data": [
           {
               "type": "carts",
               "id": "1ce91011-8d60-59ef-9fe0-4493ef3628b2",
               "attributes": {...},
               "links": {...}
           },
           {
               "type": "carts",
               "id": "9183f604-9b2c-53d9-acbf-cf59b9b2ff9f",
               "attributes": {...},
               "links": {...}
           }
       ],
       "links": {...}
   }
   ```

   In a single cart environment, items from the guest cart have been added to the user's own cart.

   Response sample:

   ```json
   {
       "data": [
           {
               "type": "carts",
               "id": "1ce91011-8d60-59ef-9fe0-4493ef3628b2",
               "attributes": {...},
               "links": {...}
           }
       ]
   }
   ```

## Possible errors

| Code | Reason |
| --- | --- |
| `101` | Cart with given uuid not found. |
| `102` | Failed to add an item to cart. |
| `103` | Item with the given group key not found in the cart. |
| `104` | Cart uuid is missing. |
| `105` | Cart cannot be deleted. |
| `106` | Cart item cannot be deleted. |
| `107` | Failed to create a cart. |
| `109` | Anonymous customer unique id is empty. |
| `111` | Can't switch price mode when there are items in the cart. |
| `112` | Store data is invalid. |
| `113` | Cart item cannot be added. |
| `114` | Cart item cannot be updated. |
| `115` | Unauthorized cart action. |
| `116` | Currency is missing. |
| `117` | Currency is incorrect. |
| `118` | Price mode is missing. |
| `119` | Price mode is incorrect. |

For generic errors that originate from the Glue Application, see [Reference information: GlueApplication errors](/docs/integrations/spryker-glue-api/storefront-api/api-references/reference-information-storefront-application-errors.md).
