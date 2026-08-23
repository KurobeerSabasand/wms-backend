//Webサーバーを作る
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

//ファイルやフォルダのパスを安全に作るためのNode.js組み込みモジュール
const path = require("path");

const cors = require("cors");

const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const SECRET_KEY = "your-secret-key";

const { Pool } = require("pg");

//CORS を設定する
app.use(cors({
    origin: [
        "https://kurobeersabasand.github.io"
    ],
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"]
}));

// PostgreSQL（Supabase）接続
const pool = new Pool({
    connectionString: process.env.SUPABASE_DB_URL,
});

// テーブル作成（初回のみ）
(async () => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users(
            id SERIAL PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL
        );
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS products(
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            stock INTEGER NOT NULL
        );
    `);
})();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

//ユーザー登録 API（サインアップ）
app.post("/api/signup", async (req, res) => {
    const { username, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    try {
        await pool.query(
            "INSERT INTO users (username, password) VALUES ($1, $2)",
            [username, hashedPassword]
        );
        res.json({ ok: true });
    } catch (err) {
        res.status(400).json({ error: "ユーザー名が既に存在します" });
    }
});

//ログイン API（JWT 発行）
app.post("/api/login", async (req, res) => {
    const { username, password } = req.body;

    const result = await pool.query(
        "SELECT * FROM users WHERE username = $1",
        [username]
    );
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: "ユーザーが存在しません" });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: "パスワードが違います" });

    const token = jwt.sign({ id: user.id, username: user.username }, SECRET_KEY, { expiresIn: "1h" });
    res.json({ ok: true, token });
});

// JWT 認証
function authenticateToken(req, res, next) {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];
    if (!token) return res.status(401).json({ error: "トークンがありません" });
    jwt.verify(token, SECRET_KEY, (err, user) => {
        if (err) return res.status(403).json({ error: "トークンが無効です" });
        req.user = user;
        next();
    });
}

//在庫一覧ページを作る
//API化
app.get("/api/products", authenticateToken, async (req, res) => {
    const result = await pool.query("SELECT * FROM products");
    res.json(result.rows);
});

//商品追加
app.post("/api/products", authenticateToken, async (req, res) => {
    const { name, stock } = req.body;
    const result = await pool.query(
        "INSERT INTO products (name, stock) VALUES ($1, $2) RETURNING *",
        [name, stock]
    );
    res.json({ ok: true, product: result.rows[0] });
});

//商品1件を取得（GET /api/products/:id）
app.get("/api/products/:id", authenticateToken, async (req, res) => {
    const id = Number(req.params.id);
    const result = await pool.query("SELECT * FROM products WHERE id = $1", [id]);
    const product = result.rows[0];
    if (!product) {
        return res.status(404).json({ error: "商品が見つかりません" });
    }
    res.json(product);
});

//在庫を増減する（PUT /api/products/:id/stock）
app.put("/api/products/:id/stock", authenticateToken, async (req, res) => {
    const id = Number(req.params.id);
    const { amount } = req.body;
    const result = await pool.query("SELECT * FROM products WHERE id = $1", [id]);
    const product = result.rows[0];

    if (!product) {
        return res.status(404).json({ error: "商品が見つかりません" });
    }
    const newStock = product.stock + Number(amount);
    if (newStock < 0) {
        return res.status(400).json({ error: "在庫不足です" });
    }

    await pool.query("UPDATE products SET stock = $1 WHERE id = $2", [newStock, id]);
    res.json({ ok: true, product: { ...product, stock: newStock } });
});

//商品を削除する（DELETE /api/products/:id）
app.delete("/api/products/:id", authenticateToken, async (req, res) => {
    const id = Number(req.params.id);
    const result = await pool.query("DELETE FROM products WHERE id = $1", [id]);
    if (!result.rowCount === 0) {
        return res.status(404).json({ error: "商品が見つかりません" });
    }
    res.json({ ok: true });
});

app.listen(PORT, () => {
    console.log(`webサーバーを起動しました ポート:${PORT}`);
});

//main.htmlからの入力に切り替えたためコンソール入力を廃止
// const readline = require("readline");
// const rl = readline.createInterface({
//     input: process.stdin,
//     output: process.stdout
// });

//Live Serverで静的ファイルを配信するためバックエンド（Express）からのhtml/css/jsの配信を停止する
// app.use(express.static("public"));
// app.use(express.static(path.join(__dirname, "../frontend")));
// //画面をサーバー側で作る（SSR：Server Side Rendering）ためのエンジン
// const expressLayouts = require("express-ejs-layouts");

//API化に伴いHTMLを返す処理（render）を廃止
// //フォーム画面を作る（GET）
// app.get("/add", (req, res) => {
//     res.render("add", {
//         layout: "layout",
//         title: "商品追加"
//     });
// });

//SQLiteに切り替えたためJSONファイル読み込みを廃止
// const fs = require("fs");
// function loadProducts() {
//     const data = fs.readFileSync("products.json", "utf-8");
//     return JSON.parse(data);
// }

//データベース接続をbetter-sqlite3からpg（Pool）に変更
// const Database = require("better-sqlite3");
// const dbPath = path.join("/opt/render/project/src/products.db")
// const db = new Database(dbPath);
// db.exec(`
//     CREATE TABLE IF NOT EXISTS products(
//         id INTEGER PRIMARY KEY AUTOINCREMENT,
//         name TXT NOT NULL,
//         stock INTEGER NOT NULL
//     )
// `);
// db.exec(`
//     CREATE TABLE IF NOT EXISTS users(
//         id INTEGER PRIMARY KEY AUTOINCREMENT,
//         username TEXT UNIQUE NOT NULL,
//         password TEXT NOT NULL
//     )
// `);
// module.exports = db;
// app.post("/api/signup", async (req, res) => {
//     const { username, password } = req.body;
//     const hashedPassword = await bcrypt.hash(password, 10);
//     try {
//         db.prepare("INSERT INTO users (username,password) VALUES (?, ?)").run(username, hashedPassword);
//         res.json({ ok: true });
//     } catch (err) {
//         res.status(400).json({ error: "ユーザー名が既に存在します" });
//     }
// });