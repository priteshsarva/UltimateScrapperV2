import { DB } from "../models/connect.js";
import express from "express";
const productCategories = express()

productCategories.get('/allresults', (req, res) => {


    res.set('content-type', 'application/json');
    let sql = `SELECT * FROM ProductCategories ;`
    try {
        DB.all(sql, [], (err, rows) => {
            if (err) {
                throw err;
            }
            let content = JSON.stringify(rows);
            res.send(content)
        })
    } catch (err) {
        console.log(err.message);
        res.status(467)
        res.send(`{"code":"467","status":${err.message}}`);
    }



})

productCategories.post('/add', (req, res) => {
    res.send("need to setup")

    console.log("need to setup");

    // console.log(req.body);

    // const dynamicValues = req.body;// Extracting all keys and values from req.body 
    // // Constructing the SQL query dynamically
    // const columns = Object.keys(dynamicValues).join(', ');
    // const placeholders = Object.keys(dynamicValues).map(() => '?').join(', ');
    // const values = Object.values(dynamicValues);


    // res.set('content-type', 'application/json');
    // // let sql = 'INSERT INTO ENEMIES(ENEMIES_NAME, ENEMIES_REASON) VALUES(?,?)';

    // let sql = `INSERT INTO SIZES (${columns}) VALUES (${placeholders})`;
    // let newId;

    // try {
    //     DB.run(sql, [...values], function (err) {
    //         console.log(err);

    //         if (err) {
    //             // console.error(err.message); // Log the error message
    //             // Check for specific error codes if needed
    //             if (err.code === 'SQLITE_CONSTRAINT') {
    //                 return res.status(400).send({
    //                     code: "400",
    //                     status: "Unique constraint failed",
    //                     message: "A record with this unique value already exists."
    //                 });
    //             } else {
    //                 return res.status(500).send({
    //                     code: "500",
    //                     status: "Internal Server Error",
    //                     message: err.message
    //                 });
    //             }
    //         }
    //         newId = this.lastID;
    //         res.status(201);
    //         let data = { status: 201, message: `data add with id: ${newId}` };
    //         let content = JSON.stringify(data);
    //         res.send(content)
    //     })

    // } catch (err) {
    //     console.log(err.message);
    //     res.status(467)
    //     res.send(`{"code":"467","status":${err.message}}`);
    // }
})

productCategories.post('/update', (req, res) => {

    res.send("need to setup")

    console.log("need to setup");



    // res.set('content-type', 'application/json');
    // let query = 'UPDATE SIZES SET ';
    // const updates = []
    // const values = []

    // if (typeof req.body.sizeName !== 'undefined') {
    //     updates.push(`sizeName = ?`);
    //     values.push(req.body.sizeName);
    // }

    // let sql = query += updates.join(', ') + ' WHERE sizeId = ?';
    // console.log(sql);

    // let id = req.body.sizeId;

    // try {
    //     DB.run(sql, [...values, id], function (err) {

    //         if (err) {
    //             // console.error(err.message); // Log the error message
    //             // Check for specific error codes if needed
    //             if (err.code === 'SQLITE_CONSTRAINT') {
    //                 return res.status(400).send({
    //                     code: "400",
    //                     status: "Unique constraint failed",
    //                     message: "A record with this unique value already exists."
    //                 });
    //             } else {
    //                 return res.status(500).send({
    //                     code: "500",
    //                     status: "Internal Server Error",
    //                     message: err.message,
    //                 });
    //             }
    //         }


    //         if (this.changes === 1) {
    //             // file updated succefully
    //             res.status(200);
    //             let data = { status: 200, message: `data updated with id: ${id} ` }
    //             let content = JSON.stringify(data);
    //             res.send(content);
    //         } else {
    //             res.status(201);
    //             let data = { status: 201, message: `no data has been changed` }
    //             let content = JSON.stringify(data);
    //             res.send(content);
    //         }

    //     })

    // } catch (err) {
    //     console.log(err.message);
    //     res.status(467);
    //     res.send(`{ "code": "467", "status":${err.message} } `);

    // }
})

productCategories.delete('/delete', (req, res) => {

    res.send("need to setup")

    console.log("need to setup");



    // res.set('content-type', 'application/json');
    // let sql = 'DELETE FROM SIZES WHERE sizeId = ?';
    // let id = req.body.sizeId;

    // try {
    //     DB.run(sql, [id], function (err) {
    //         if (err) throw err;
    //         if (this.changes === 1) {
    //             // file deleted succefully
    //             res.status(200);
    //             let data = { status: 200, message: `data delete with id: ${id} ` }
    //             let content = JSON.stringify(data);
    //             res.send(content);
    //         } else {
    //             res.status(201);
    //             let data = { status: 201, message: `no data has been found` }
    //             let content = JSON.stringify(data);
    //             res.send(content);
    //         }

    //     })

    // } catch (err) {
    //     console.log(err.message);
    //     res.status(467)
    //     res.send(`{ "code": "467", "status":${err.message} } `);
    // }

})





export default productCategories;