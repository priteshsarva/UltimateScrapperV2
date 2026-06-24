import puppeteer from 'puppeteer';
import * as cheerio from 'cheerio';

const baseUrls = ['https://oneshoess.cartpe.in', 'https://reseller-store.cartpe.in'];

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchDataa() {
    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: { width: 1080, height: 800 },
        args: ['--window-size=1080,800']
    });
    const page = await browser.newPage();
    const productss = []
    const allproducts = [];

    baseUrls.forEach(async (url) => {
        const fullUrl = `${url}/allcategory.html`;
        try {
            const categories = await scrapeCategories(page, fullUrl);
            productss.push(await scrapeProducts(page, categories,url));
        } catch (error) {
            console.error('Error fetching data:', error);
        } finally {
            allproducts.push(productss)
            await browser.close();
        }
    });
    return await allproducts;
}

async function scrapeCategories(page, fullUrl) {

    await page.goto(fullUrl, { waitUntil: 'networkidle2' });
    return await page.evaluate(() => {
        const categoryElements = document.querySelectorAll('.cat-area');
        return Array.from(categoryElements).map(element => ({
            catTitle: element.querySelector('.cat-text').innerText,
            catimg: element.querySelector('img').src,
            caturl: element.querySelector('a').href,
        }));
    });

}

async function scrapeImages(page, url) {
    console.log(`Scraping images from: ${url}`);
    const imageSlides = [];
    try {
        // Navigate to the product detail page
        await page.goto(url, { waitUntil: 'networkidle2' });
        const htmlContent = await page.content();

        // Load the HTML into Cheerio
        const $ = cheerio.load(htmlContent);

        // const productShortDescription = $('#home p').text();
        const productShortDescription = $('#home p').html(); // Get inner HTML of <p> inside #home

        // Extract image URLs
        $('#slider img').each((index, element) => {
            const imgSrc = $(element).attr('src');
            if (imgSrc) {
                imageSlides.push(imgSrc);
            }
        });

        console.log('Scraped images:', imageSlides);
        console.log('Scraped description:', productShortDescription);

        return { imageSlides, productShortDescription };
    } catch (error) {
        console.error('Error fetching images:', error.message);
        return [];
    }
}

function getFirstTwoWords(inputString) {
    // Split the string into words using space as a delimiter
    const words = inputString.split(' ');

    // Join the first two words back into a string
    return words.slice(0, 2).join(' ');
}

async function scrapeProducts(page, categories) {

    const products = [];


    for (const cat of categories) {
        const productUrl = cat.caturl;
        await page.goto(productUrl, { waitUntil: 'networkidle2' });

        try {
            const productCount = await page.evaluate(() => {
                return document.querySelector('#total_result_cnt').innerText;
            });

            // Uncomment this if you want to load more products
            // await viewMore(page, productCount);
            console.log("After view more");

            // Extract products
            const productElements = await page.evaluate(() => {
                const elements = document.querySelectorAll('.single-product');
                return Array.from(elements).map(element => ({
                    title: element.querySelector('.product-details > a > h6').innerText.trim(),
                    price: element.querySelector('.product-details > div > h6:nth-child(1)').innerText.trim(),
                    featuredimg: element.querySelector('.product-img-block img').src,
                    detailUrl: element.querySelector('.product-img-block img').parentElement.getAttribute('href'),
                    sizes: Array.from(element.querySelectorAll('.product-details > div > div > label'))
                        .slice(1) // Skip the first label if it's not a size
                        .map(label => label.innerText.trim()),
                }));
            });

            // Scrape images for each product
            for (const product of productElements) {
                const { imageUrl, productShortDescription } = await scrapeImages(page, product.detailUrl);
                const result = getFirstTwoWords(product.title);
                products.push({
                    productName: product.title,
                    productOriginalPrice: product.price,
                    productBrand: result,
                    featuredimg: product.featuredimg,
                    sizeName: product.sizes.map(Number),
                    productUrl: product.detailUrl,
                    imageUrl,
                    productShortDescription,
                    catName: cat.catTitle, // Assign the first category to all products
                    //  Need to make
                    // "productFetchedFrom": url  
                });
            }

        } catch (error) {
            console.log("No Product Found");
        }

    }

    return products;
}

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