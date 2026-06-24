import sqlite3 from 'sqlite3';
const sql3 = sqlite3.verbose();



const connected = (err) => {
    if (err) {
        return console.error(err.message);
    }
    console.log("Connected to Database")
}

const DB = new sql3.Database('./DataBase.db', sqlite3.OPEN_READWRITE, connected)


DB.run(`CREATE TABLE IF NOT EXISTS TAGS (
    tagId INTEGER PRIMARY KEY AUTOINCREMENT,
    tagName TEXT UNIQUE NOT NULL
);`, [], (err) => {
    if (err) {
        return console.error(err.message);
    }
    console.log('TAGS TABLE Created');
})


DB.run(`CREATE TABLE IF NOT EXISTS CATEGORIES (
    catId INTEGER PRIMARY KEY AUTOINCREMENT,
    catName TEXT UNIQUE NOT NULL,
    catImg TEXT,
    catSlug TEXT
);
`, [], (err) => {
    if (err) {
        return console.error(err.message);
    }
    console.log('CATEGORIES TABLE Created');
})
DB.run(`CREATE TABLE IF NOT EXISTS SIZES (
    sizeId INTEGER PRIMARY KEY AUTOINCREMENT,
    sizeName TEXT UNIQUE NOT NULL
);`, [], (err) => {
    if (err) {
        return console.error(err.message);
    }
    console.log('SIZES TABLE Created');
})

DB.run(`CREATE TABLE IF NOT EXISTS BRAND (
    brandId INTEGER PRIMARY KEY AUTOINCREMENT,
    brandName TEXT UNIQUE NOT NULL
);`, [], (err) => {
    if (err) {
        return console.error(err.message);
    }
    console.log('SIZES TABLE Created');
})


DB.run(`CREATE TABLE IF NOT EXISTS VENDORS (
    vendorId INTEGER PRIMARY KEY AUTOINCREMENT,
    vendorName TEXT NOT NULL,
    vendorWebsiteUrl TEXT,
    vendorLastFetchedDate DATETIME,
    vendorDate DATETIME DEFAULT CURRENT_TIMESTAMP
);`, [], (err) => {
    if (err) {
        return console.error(err.message);
    }
    console.log('VENDORS TABLE Created');
})

DB.run(`CREATE TABLE IF NOT EXISTS PRODUCTS (
    productId INTEGER PRIMARY KEY AUTOINCREMENT,
    productName TEXT NOT NULL,
    productDateCreation DATETIME DEFAULT CURRENT_TIMESTAMP,
    productLastUpdated DATETIME DEFAULT CURRENT_TIMESTAMP,
    productPrice REAL,
    productPriceWithoutDiscount REAL,
    productOriginalPrice REAL NOT NULL,
    productFetchedFrom TEXT,
    productUrl TEXT,
    featuredimg TEXT,
    imageUrl TEXT,
    videoUrl TEXT,
    productShortDescription TEXT,
    productDescription TEXT,
    productBrand TEXT,
    sizeName TEXT,
    catName TEXT,               
    availability boolean,
    FOREIGN KEY (productFetchedFrom) REFERENCES VENDORS(vendorId)
);`, [], (err) => {
    if (err) {
        return console.error(err.message);
    }
    console.log('PRODUCTS TABLE Created');
})




DB.run(`CREATE TABLE IF NOT EXISTS ProductSizes (
    ProductId INTEGER,
    SizeId INTEGER,
    PRIMARY KEY (ProductId, SizeId),

    FOREIGN KEY (ProductId) REFERENCES PRODUCTS(productId),
    FOREIGN KEY (SizeId) REFERENCES SIZES(sizeId)
);`, [], (err) => {
    if (err) {
        return console.error(err.message);
    }
    console.log('ProductSizes TABLE Created');
})
DB.run(`CREATE TABLE IF NOT EXISTS ProductBrand (
    ProductId INTEGER,
    BrandId INTEGER,
    PRIMARY KEY (ProductId, BrandId),

    FOREIGN KEY (ProductId) REFERENCES PRODUCTS(productId),
    FOREIGN KEY (BrandId) REFERENCES BRAND(brandId)
);`, [], (err) => {
    if (err) {
        return console.error(err.message);
    }
    console.log('ProductSizes TABLE Created');
})

DB.run(`CREATE TABLE IF NOT EXISTS ProductCategories (
    ProductId INTEGER,
    CategoryId INTEGER,
    PRIMARY KEY (ProductId, CategoryId),

    FOREIGN KEY (ProductId) REFERENCES PRODUCTS(productId),
    FOREIGN KEY (CategoryId) REFERENCES CATEGORIES(catId)
);`, [], (err) => {
    if (err) {
        return console.error(err.message);
    }
    console.log('ProductCategories TABLE Created');
})

DB.run(`CREATE TABLE IF NOT EXISTS ProductTags (
    ProductId INTEGER,
    TagId INTEGER,
    PRIMARY KEY (ProductId, TagId),

    FOREIGN KEY (ProductId) REFERENCES PRODUCTS(productId),
    FOREIGN KEY (TagId) REFERENCES TAGS(tagId)
);`, [], (err) => {
    if (err) {
        return console.error(err.message);
    }
    console.log('ProductTags TABLE Created');
})



//pending to make api
DB.run(`CREATE TABLE IF NOT EXISTS ProductReviews (
    ProductId INTEGER,
    ReviewId INTEGER,
    PRIMARY KEY (ProductId, ReviewId),

    FOREIGN KEY (ProductId) REFERENCES PRODUCTS(productId),
    FOREIGN KEY (ReviewId) REFERENCES REVIEWS(reviewId)
);`, [], (err) => {
    if (err) {
        return console.error(err.message);
    }
    console.log('ProductReviews TABLE Created');
})

DB.run(`CREATE TABLE IF NOT EXISTS REVIEWS (
    reviewId INTEGER PRIMARY KEY AUTOINCREMENT,
    reviewName TEXT NOT NULL,
    reviewText TEXT NOT NULL,
    reviewStars INTEGER CHECK(reviewStars >= 1 AND reviewStars <= 5)
);
`, [], (err) => {
    if (err) {
        return console.error(err.message);
    }
    console.log('REVIEWS TABLE Created');
})

export { DB };