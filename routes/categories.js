import { DB } from "../models/connect.js";
import express from "express";
const categories = express()

categories.get('/allresults', (req, res) => {

    // fetchData()
    //gett all data from table
    res.set('content-type', 'application/json');
    let sql = `
    SELECT * FROM CATEGORIES;
    `

    let data = { category: [] };
    try {
        DB.all(sql, [], (err, rows) => {
            if (err) {
                throw err;
            }
            rows.forEach((row) => {
                data.category.push({ ...row });
            })
            let content = JSON.stringify(rows);
            res.send(content)
            console.log(...rows);

        })
    } catch (err) {
        console.log(err.message);
        res.status(467)
        res.send(`{"code":"467","status":${err.message}}`);
    }

})


categories.post('/add', (req, res) => {
    console.log(req.body);

    const dynamicValues = req.body;// Extracting all keys and values from req.body 
    // Constructing the SQL query dynamically
    const columns = Object.keys(dynamicValues).join(', ');
    const placeholders = Object.keys(dynamicValues).map(() => '?').join(', ');
    const values = Object.values(dynamicValues);


    res.set('content-type', 'application/json');
    // let sql = 'INSERT INTO ENEMIES(ENEMIES_NAME, ENEMIES_REASON) VALUES(?,?)';
    // console.log(`INSERT INTO CATEGORIES (${columns}) VALUES (${values})`);

    let sql = `INSERT INTO CATEGORIES (${columns}) VALUES (${placeholders})`;
    let newId;

    try {
        DB.run(sql, [...values], function (err) {
            console.log(err);

            if (err) {
                // console.error(err.message); // Log the error message
                // Check for specific error codes if needed
                if (err.code === 'SQLITE_CONSTRAINT') {
                    return res.status(400).send({
                        code: "400",
                        status: "Unique constraint failed",
                        message: "A record with this unique value already exists."
                    });
                } else {
                    return res.status(500).send({
                        code: "500",
                        status: "Internal Server Error",
                        message: err.message
                    });
                }
            }
            newId = this.lastID;
            res.status(201);
            let data = { status: 201, message: `data add with id: ${newId}` };
            let content = JSON.stringify(data);
            res.send(content)
        })

    } catch (err) {
        console.log(err.message);
        res.status(467)
        res.send(`{"code":"467","status":${err.message}}`);
    }
})


categories.post('/update', (req, res) => {
    res.set('content-type', 'application/json');
    let query = 'UPDATE CATEGORIES SET ';
    const updates = []
    const values = []

    if (typeof req.body.catName !== 'undefined') {
        updates.push(`catName = ?`);
        values.push(req.body.catName);
    }
    if (typeof req.body.catImg !== 'undefined') {
        updates.push(`catImg = ?`);
        values.push(req.body.catImg);
    }
    if (typeof req.body.catSlug !== 'undefined') {
        updates.push(`catSlug = ?`);
        values.push(req.body.catSlug);
    }


    let sql = query += updates.join(', ') + ' WHERE catId = ?';
    let id = req.body.catId;

    try {
        DB.run(sql, [...values, req.body.catId], function (err) {

            if (err) {
                // console.error(err.message); // Log the error message
                // Check for specific error codes if needed
                if (err.code === 'SQLITE_CONSTRAINT') {
                    return res.status(400).send({
                        code: "400",
                        status: "Unique constraint failed",
                        message: "A record with this unique value already exists."
                    });
                } else {
                    return res.status(500).send({
                        code: "500",
                        status: "Internal Server Error",
                        message: err.message
                    });
                }
            }


            if (this.changes === 1) {
                // file updated succefully
                res.status(200);
                let data = { status: 200, message: `data updated with id: ${this.lastID} ` }
                let content = JSON.stringify(data);
                res.send(content);
            } else {
                res.status(201);
                let data = { status: 201, message: `no data has been changed` }
            }

        })

    } catch (err) {
        console.log(err.message);
        res.status(467);
        res.send(`{ "code": "467", "status":${err.message} } `);

    }
})

categories.delete('/delete', (req, res) => {
    res.set('content-type', 'application/json');
    let sql = 'DELETE FROM CATEGORIES WHERE catId = ?';

    try {
        DB.run(sql, [req.body.catId], function (err) {
            if (err) throw err;
            if (this.changes === 1) {
                // file deleted succefully
                res.status(200);
                let data = { status: 200, message: `data delete with id: ${req.body.catId} ` }
                let content = JSON.stringify(data);
                res.send(content);
            } else {
                res.status(201);
                let data = { status: 201, message: `no data has been found` }
                let content = JSON.stringify(data);
                res.send(content);
            }

        })

    } catch (err) {
        console.log(err.message);
        res.status(467)
        res.send(`{ "code": "467", "status":${err.message} } `);
    }

})




export default categories;