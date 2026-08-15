//Webサーバーを作る
const express = require("express");
//expressにレイアウト機能を使えるようにする
const expressLayouts = require("express-ejs-layouts");
//frontendフォルダを静的ファイルとして配信
const path = require("path");
//JSON読み込み
const fs = require("fs");
//CORS を設定する
const cors = require("cors");
//database.js を作る（SQLite 接続）
const Database = require("better-sqlite3");
// データベースファイルを作成（なければ自動生成）
const db = new Database(__dirname, "products.db");

const app = express();
const PORT = 3000;

app.set("view engine", "ejs");
app.use(expressLayouts);

//publicを使う
app.use(express.static("public"));

//Live Serverでhtml/css/jsを配信するためバックエンド（Express）からのhtml/css/jsの配信を停止する
// //frontendフォルダを静的ファイルとして配信
// app.use(express.static(path.join(__dirname, "../frontend")));

//CORS を設定する
app.use(cors({
    origin: [
        "http://localhost:5500",
        "http://127.0.0.1:5500",
        "https://KurbeerSabasand.github.io"
    ],
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true
}));

// テーブル作成
db.exec(`
    CREATE TABLE IF NOT EXISTS products(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TXT NOT NULL,
        stock INTEGER NOT NULL
    )
`);
module.exports = db;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

//SQLite版に変更
// //JSONファイルを読み込む
// function loadProducts() {
//     const data = fs.readFileSync("products.json", "utf-8");
//     return JSON.parse(data);
// }
// //JSONファイルに保存する
// function saveProducts(products) {
//     fs.writeFileSync("products.json", JSON.stringify(products, null, 2));
// }

//在庫一覧ページを作る
//API化
app.get("/api/products", (req, res) => {
    const products = db.prepare("SELECT * FROM products").all();
    res.json(products);
});

//API化に伴いHTMLを返す処理（render）は不要となる
// //フォーム画面を作る（GET）
// app.get("/add", (req, res) => {
//     res.render("add", {
//         layout: "layout",
//         title: "商品追加"
//     });
// });

//フォーム送信を受け取る（POST）
//API化
app.post("/api/products", (req, res) => {
    const { name, stock } = req.body;
    const stmt = db.prepare("INSERT INTO products (name, stock) VALUES (?, ?)");
    const result = stmt.run(name, Number(stock));
    res.json({
        ok: true,
        product: { id: result.lastInsertRowid, name, stock: Number(stock) }
    });
});

//商品1件を取得（GET /api/products/:id）
app.get("/api/products/:id", (req, res) => {
    const id = Number(req.params.id);
    const product = db.prepare("SELECT * FROM products WHERE id = ?").get(id);
    if (!product) {
        return res.status(404).json({ error: "商品が見つかりません" });
    }
    res.json(product);
});

//在庫を増減する（PUT /api/products/:id/stock）
app.put("/api/products/:id/stock", (req, res) => {
    const id = Number(req.params.id);
    const { amount } = req.body;
    const product = db.prepare("SELECT * FROM products WHERE id = ?").get(id);
    if (!product) {
        return res.status(404).json({ error: "商品が見つかりません" });
    }
    const newStock = product.stock + Number(amount);
    if (newStock < 0) {
        return res.status(400).json({ error: "在庫不足です" });
    }
    db.prepare("UPDATE products SET stock = ? WHERE id = ?").run(newStock, id);
    res.json({ ok: true, product: { ...product, stock: newStock } });
});

//商品を削除する（DELETE /api/products/:id）
app.delete("/api/products/:id", (req, res) => {
    const id = Number(req.params.id);
    const result = db.prepare("DELETE FROM products WHERE id = ?").run(id);
    if (!result.changes === 0) {
        return res.status(404).json({ error: "商品が見つかりません" });
    }
    res.json({ ok: true });
});

// //コンソールから入力を受け取れるようになる
// const readline = require("readline");
// const rl = readline.createInterface({
//     input: process.stdin,
//     output: process.stdout
// });
// //メニューを表示する関数
// function showMenu() {
//     console.log("\n===在庫管理メニュー===");
//     console.log("1.在庫一覧を表示");
//     console.log("2.商品を追加");
//     console.log("3.在庫を増やす");
//     console.log("4.在庫を減らす");
//     console.log("5.CSV出力")
//     console.log("6.終了");
//     rl.question("番号を選んでください:", handleMenu);
// }
//showMenu();

app.listen(PORT, () => {
    console.log(`webサーバーを起動しました http://localhost:${PORT}`);
});