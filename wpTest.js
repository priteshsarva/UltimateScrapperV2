// testWpProduct.js
import { createOrUpdateProduct } from "./controller/wpProduct.js";

const sampleProduct = {
  productName: "ARMANI EXCHANGE",
  productOriginalPrice: 650,
  productFetchedFrom: "https://famwatch.cartpe.in/",
  productUrl: "https://famwatch.cartpe.in/armani-exchange-famwatch3893.html?color=",
  featuredimg: "https://cdn.cartpe.in/images/gallery_sm/68e2a6a73fd39.jpeg",
  imageUrl: '["https://cdn.cartpe.in/images/gallery_md/68e2a6a73fd39.jpeg","https://cdn.cartpe.in/images/gallery_md/68e2a6a75fd09.jpeg"]',
  videoUrl: null,
  productShortDescription: null,
  productDescription: null,
  productBrand: "ARMANI EXCHANGE",
  sizeName: '[""]',
  catName: "Mens Watch",
  availability: 1
};

await createOrUpdateProduct(sampleProduct);
