
import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
    const { admin } = await authenticate.admin(request);

    // 1. Search for the product by SKU: 100000
    const searchResponse = await admin.graphql(
        `#graphql
    query findProductBySku {
      products(first: 5, query: "sku:100000") {
        edges {
          node {
            id
            title
            sku
          }
        }
      }
    }`
    );

    const searchResult = await searchResponse.json();
    const products = searchResult.data.products.edges;

    if (products.length === 0) {
        return new Response(
            "<html><body><h1>✅ Product SKU:100000 not found (already deleted).</h1></body></html>",
            { headers: { "Content-Type": "text/html" } }
        );
    }

    // 2. Delete the product(s) found
    const deletedIds = [];
    for (const edge of products) {
        const productId = edge.node.id;
        console.log(`Deleting product: ${edge.node.title} (${productId})`);

        const deleteResponse = await admin.graphql(
            `#graphql
      mutation deleteProduct($input: ProductDeleteInput!) {
        productDelete(input: $input) {
          deletedProductId
          userErrors {
            field
            message
          }
        }
      }`,
            {
                variables: {
                    input: {
                        id: productId,
                    },
                },
            }
        );
        deletedIds.push(productId);
    }

    return new Response(
        `<html><body><h1>✅ Successfully deleted ${deletedIds.length} product(s) with SKU:100000.</h1><p>Deleted IDs: ${deletedIds.join(", ")}</p></body></html>`,
        { headers: { "Content-Type": "text/html" } }
    );
};
