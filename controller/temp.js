import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import { DB } from '../connect.js';

// Use the stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

// Base URLs to scrape
const baseUrls = ['https://oneshoess.cartpe.in', 'https://reseller-store.cartpe.in'];

// Utility function to introduce delays
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Main function to fetch data
async function fetchDataa() {
    const browser = await puppeteer.launch({
        headless: false, // Set to true for headless mode
        defaultViewport: { width: 1080, height: 800 },
        args: ['--window-size=1080,800']
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

    const allproducts = [];

    // Use a for...of loop to handle asynchronous operations
    for (const url of baseUrls) {
        const fullUrl = `${url}/allcategory.html`;
        let productss = []; // Initialize productss for each URL

        try {
            // Scrape categories from the current URL
            const categories = await scrapeCategories(page, fullUrl);
            // Scrape products for each category
            productss = await scrapeProducts(page, categories, url); // Pass the base URL here
        } catch (error) {
            console.error(`Error fetching data from ${url}:`, error);
        } finally {
            // Add scraped products to the final array
            allproducts.push(...productss); // Use spread operator to flatten the array
        }
    }

    // Close the browser after scraping all URLs
    await browser.close();
    console.log("finished");

    return allproducts;
}

// Function to scrape categories
async function scrapeCategories(page, fullUrl, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            // Navigate to the category page
            await page.goto(fullUrl, { waitUntil: 'networkidle2', timeout: 60000 });

            // Extract category data
            return await page.evaluate(() => {
                const categoryElements = document.querySelectorAll('.cat-area');
                return Array.from(categoryElements).map(element => ({

                    //want to add categories in database
                    //if exist then leave it otherwise add it

                    catTitle: element.querySelector('.cat-text').innerText,
                    catimg: element.querySelector('img').src,
                    caturl: element.querySelector('a').href,
                }));
            });
        } catch (error) {
            console.error(`Attempt ${i + 1} failed:`, error.message);
            if (i === retries - 1) throw error; // Throw error if all retries fail
            await delay(5000); // Wait 5 seconds before retrying
        }
    }
}

// Function to scrape products
async function scrapeProducts(page, categories, baseUrl) { // Add baseUrl parameter
    const products = [];

    // Loop through each category
    for (const cat of categories) {
        const productUrl = cat.caturl;
        try {
            // Navigate to the product page
            await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 60000 });
            await page.waitForSelector('.single-product', { timeout: 60000 }); // Increase timeout

            // Get the total number of products
            const productCount = await page.evaluate(() => {
                return document.querySelector('#total_result_cnt')?.innerText || 0;
            });

            console.log("After view more");

            // Extract product details
            const productElements = await page.evaluate(() => {
                const elements = document.querySelectorAll('.single-product');
                return Array.from(elements).map(element => ({
                    title: element.querySelector('.product-details > a > h6')?.innerText.trim(),
                    price: element.querySelector('.product-details > div > h6:nth-child(1)')?.innerText.trim(),
                    featuredimg: element.querySelector('.product-img-block img')?.src,
                    detailUrl: element.querySelector('.product-img-block img')?.parentElement.getAttribute('href'),
                    sizes: Array.from(element.querySelectorAll('.product-details > div > div > label'))
                        .slice(1) // Skip the first label if it's not a size
                        .map(label => label.innerText.trim()),
                }));
            });

            // Scrape images and descriptions for each product
            for (const product of productElements) {
                const { imageSlides, productShortDescription } = await scrapeImages(page, product.detailUrl);
                const result = getFirstTwoWords(product.title);
                products.push({
                    productName: product.title,
                    productOriginalPrice: product.price,
                    productBrand: result,
                    featuredimg: product.featuredimg,
                    sizeName: product.sizes.map(Number),
                    productUrl: product.detailUrl,
                    imageUrl: imageSlides,
                    productShortDescription,
                    catName: cat.catTitle,
                    productFetchedFrom: baseUrl // Use the baseUrl parameter
                });
                // add this products in my database
                // also rember im using many to many relations type tables , i have alredy gievn you my databse structure folow accoring to that
            }
        } catch (error) {
            console.error(`Error scraping products from ${productUrl}:`, error.message);
        }
    } 

    return products;
}

// Function to scrape images and descriptions
async function scrapeImages(page, url) {
    console.log(`Scraping images from: ${url}`);
    const imageSlides = [];
    try {
        // Navigate to the product detail page
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        const htmlContent = await page.content();

        // Load the HTML into Cheerio
        const $ = cheerio.load(htmlContent);

        // Extract the product description
        const productShortDescription = $('#home p').html();

        // Extract image URLs
        $('#slider img').each((index, element) => {
            const imgSrc = $(element).attr('src');
            if (imgSrc) {
                imageSlides.push(imgSrc);
            }
        });

        console.log('Scraped images:', imageSlides);
        console.log('Scraped description:', productShortDescription);
        
        // want to download those images in my project
        // and send that images link in return file
        // if that image from the same url exist then don't download it
        // make folder according to your for the image
        // just send that img link from my project to return file in imageSlides

        return { imageSlides, productShortDescription };
    } catch (error) {
        console.error('Error fetching images:', error.message);
        return { imageSlides: [], productShortDescription: '' };
    }
}

// Utility function to get the first two words of a string
function getFirstTwoWords(inputString) {
    const words = inputString.split(' ');
    // add that words in dabase vendor 
    // if that words exist in database then don't add it
    return words.slice(0, 2).join(' ');
}

// Function to handle "View More" button clicks
async function viewMore(page, productCount) {
    const count = Math.ceil(productCount / 12);
    const viewMoreButtonSelector = '#loadmore_btn_category_product';

    await page.waitForSelector(viewMoreButtonSelector, { timeout: 10000 });
    for (let i = 0; i < count; i++) {
        try {
            await page.click(viewMoreButtonSelector);
            console.log(`Button clicked = ${i}`);
            await delay(4000);
        } catch (error) {
            console.error('Error clicking "View More" button:', error + i);
        }
    }
}

// Start the scraping process
export default fetchDataa;