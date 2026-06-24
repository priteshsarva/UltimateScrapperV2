// const axios = require('axios');
// const cheerio = require('cheerio');
import axios from 'axios';

// import cheerio  from 'cheerio';
import * as cheerio from 'cheerio';
// const CircularJSON = require('circular-json');
// import CircularJSON from 'circular-json';

// const url = 'https://oneshoess.cartpe.in/'; // Replace with your target URL
const url = 'https://oneshoess.cartpe.in/23972-special-sale.html'; // Replace with your target URL



async function fetchData() {
    const page = "allcategory.html";
    const baseUrl = "https://oneshoess.cartpe.in";
    const fullUrl = `${baseUrl}/${page}`;

    try {
        const { data } = await axios.get(fullUrl);
        const $ = cheerio.load(data);
        let categories = []

        $('.cat-area').each(async (index, element) => {
            const catTitle = $(element).find('.cat-text').text();
            const catimg = $(element).find('img').attr('src');
            const caturl = $(element).find('a').attr('href');
            categories.push({
                catTitle,
                catimg,
                caturl,
            })

        })

        productss(categories);


    } catch (error) {
        console.error('Error fetching data:', error);
    }
}

async function productss(urls) {
    let products = [];


    let url = "https://oneshoess.cartpe.in/75018-mens-shoes.html"
    const { data } = await axios.get(url);

    const $ = cheerio.load(data);

    // THIS IS THE CODE TO SCRAPE PRODUCTS FROM HOME PAGE



    const productPromises = $('.single-product').map(async (index, element) => {
        const title = $(element).find('.product-details > a > h6').text().trim();
        const price = $(element).find('.product-details > div > h6:nth-child(1)').text().trim();
        const featuredimg = $(element).find('.product-img-block img').attr('src');
        const imageUrl = await scrapeImages($(element).find('.product-img-block img').parent().attr('href'));
        const size = $(element).find('.badge .badge-primary').text().trim();

        // Return the product data as an object
        return {
            title,
            price,
            featuredimg,
            imageUrl,
            size,
            //   "category": elem
        };
    })

    const resolvedProducts = await Promise.all(productPromises);
        products.push(...resolvedProducts); // Add all products to the main array

        console.log(JSON.stringify(products, null, 2)); // Log the final


}


async function scrapeImages(url) {

    const imageSlides = [];
    try {
        // Fetch the HTML content from the URL
        const { data } = await axios.get(url);

        // Load the HTML into Cheerio
        const $ = cheerio.load(data);

        // Select the image slides (adjust selector based on actual HTML structure)


        // Assuming images are in a class named 'slide' or similar (you need to inspect and adjust accordingly)
        $('#slider img').each((index, element) => {
            const imgSrc = $(element).attr('src'); // Get the source of each image
            imageSlides.push(imgSrc); // Add to array if src exists
        });

        // Output the scraped image URLs
        // console.log('Image Slides:', imageSlides);

        return imageSlides;
    } catch (error) {
        console.error('Error fetching data:', error.message);
    }
}

// URL of the product page to scrape
// const url = 'https://oneshoess.cartpe.in/adidass-summer-climacool-grey-oneshoess.html';
// scrapeImages(url);

export default fetchData;