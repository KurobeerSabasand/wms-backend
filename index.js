// Webサーバーを作る
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

// ファイルやフォルダのパスを安全に作るためのNode.js組み込みモジュール
const path = require("path");

const cors = require("cors");

const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const SECRET_KEY = "your-secret-key";

const { Pool } = require("pg");

// CSV を取り込みするために fs を使う
const fs = require("fs");

// CSV をパースするために multer + csv-parse を使う。
const multer = require("multer");
const { parse } = require("csv-parse");
const upload = multer({ dest: "uploads/" });

// CORS を設定する
app.use(
  cors({
    origin: [
      "http://localhost:5173", // 開発環境
      "https://kurobeersabasand.github.io",
    ],
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

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

// ユーザー登録 API（サインアップ）
app.post("/api/signup", async (req, res) => {
  const { username, password } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);
  try {
    await pool.query("INSERT INTO users (username, password) VALUES ($1, $2)", [
      username,
      hashedPassword,
    ]);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: "ユーザー名が既に存在します" });
  }
});

// ログイン API（JWT 発行）
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;

  const result = await pool.query("SELECT * FROM users WHERE username = $1", [
    username,
  ]);
  const user = result.rows[0];
  if (!user) return res.status(401).json({ error: "ユーザーが存在しません" });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: "パスワードが違います" });

  const token = jwt.sign({ id: user.id, username: user.username }, SECRET_KEY, {
    expiresIn: "1h",
  });
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

// 在庫一覧ページを作る
// API化
app.get("/api/products", authenticateToken, async (req, res) => {
  const result = await pool.query("SELECT * FROM products");
  res.json(result.rows);
});

// 商品追加
app.post("/api/products", authenticateToken, async (req, res) => {
  const { name, stock } = req.body;
  const result = await pool.query(
    "INSERT INTO products (name, stock) VALUES ($1, $2) RETURNING *",
    [name, stock],
  );
  res.json({ ok: true, product: result.rows[0] });
});

// 商品1件を取得（GET /api/products/:id）
app.get("/api/products/:id", authenticateToken, async (req, res) => {
  const id = Number(req.params.id);
  const result = await pool.query("SELECT * FROM products WHERE id = $1", [id]);
  const product = result.rows[0];
  if (!product) {
    return res.status(404).json({ error: "商品が見つかりません" });
  }
  res.json(product);
});

// 在庫を増減する（PUT /api/products/:id/stock）
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

  await pool.query("UPDATE products SET stock = $1 WHERE id = $2", [
    newStock,
    id,
  ]);
  res.json({ ok: true, product: { ...product, stock: newStock } });
});

// 商品を削除する（DELETE /api/products/:id）
app.delete("/api/products/:id", authenticateToken, async (req, res) => {
  const id = Number(req.params.id);
  const result = await pool.query("DELETE FROM products WHERE id = $1", [id]);
  if (!result.rowCount === 0) {
    return res.status(404).json({ error: "商品が見つかりません" });
  }
  res.json({ ok: true });
});

// JSON 取り込み API
app.post("/api/shipments/import-json", authenticateToken, async (req, res) => {
  const { shipments } = req.body;
  if (!shipments || !Array.isArray(shipments)) {
    return res.status(400).json({ error: "shipments が必要です" });
  }
  try {
    for (const s of shipments) {
      await pool.query(
        `INSERT INTO shipments (
            shipment_id, shipment_line_id,
            product_code, quantity
            ) VALUES ($1, $2, $3, $4)`,
        [s.shipment_id, s.shipment_line_id, s.product_code, s.quantity],
      );
    }

    res.json({ message: "JSON 出荷指示を取り込みました" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "取り込みに失敗しました" });
  }
});

// CSV 取り込み API
app.post(
  "/api/shipments/import-csv",
  authenticateToken,
  upload.single("file"),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "CSV ファイルが必要です" });
    }
    const shipments = [];
    fs.createReadStream(req.file.path)
      .pipe(parse({ columns: true, trim: true }))
      .on("data", (row) => {
        shipments.push(row);
      })
      .on("end", async () => {
        try {
          for (const s of shipments) {
            await pool.query(
              `INSERT INTO shipments(shipment_id,shipment_line_id,product_code,quantity) VALUES ($1,$2,$3,$4)`,
              [
                s.shipment_id,
                Number(s.shipment_line_id),
                s.product_code,
                Number(s.quantity),
              ],
            );
          }
          res.json({ message: "CSV 出荷指示を取り込みました" });
        } catch (err) {
          console.error(err);
          res.status(500).json({ error: "取り込みに失敗しました" });
        }
      });
  },
);

// 出荷指示一覧 API（shipment_id 単位）
app.get("/api/shipments", authenticateToken, async (req, res) => {
  const { shipment_id, status } = req.query;
  let query = `
  SELECT
   shipment_id,
   status,
   COUNT(*) AS total_lines,
   SUM(quantity) AS total_quantity,
   MAX(updated_at) AS updated_at
  FROM shipments
  WHERE 1=1
  `;
  const params = [];
  if (shipment_id) {
    params.push(shipment_id);
    query += ` AND shipment_id = $${params.length}`;
  }
  if (status) {
    params.push(status);
    query += ` AND status = $${params.length}`;
  }
  query += ` GROUP BY shipment_id, status ORDER BY shipment_id`;
  try {
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "一覧取得に失敗しました" });
  }
});

// 出荷指示詳細 API（shipment_line_id 単位）
app.get(
  "/api/shipments/:shipment_id/lines",
  authenticateToken,
  async (req, res) => {
    const shipmentId = req.params.shipment_id;
    try {
      const result = await pool.query(
        `SELECT 
        shipment_line_id,
        product_code,
        quantity,
        quality,
        destination_name,
        destination_zip,
        destination_address,
        destination_tel,
        status,
        updated_at 
        FROM shipments 
        WHERE shipment_id = $1 
        ORDER BY shipment_line_id`,
        [shipmentId],
      );
      res.json(result.rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "詳細取得に失敗しました" });
    }
  },
);

// 出荷指示の複数完了 API
app.post("/api/shipments/complete", authenticateToken, async (req, res) => {
  const { shipment_ids } = req.body;

  if (!shipment_ids || !Array.isArray(shipment_ids)) {
    return res.status(400).json({ error: "shipment_ids が必要です" });
  }

  try {
    await pool.query("BEGIN");

    for (const shipmentId of shipment_ids) {
      // 明細を取得
      const lines = await pool.query(
        `SELECT product_code,quantity
        FROM shipments
        WHERE shipment_id = $1`,
        [shipmentId],
      );

      // 在庫マイナス処理
      for (const line of lines.rows) {
        await pool.query(
          `UPDATE products
        SET stock = stock - $1
        WHERE name = $2`,
          [line.quantity, line.product_code],
        );
      }

      // 出荷指示ステータス更新
      await pool.query(
        `UPDATE shipments
      SET status = 'completed',
      updated_at = NOW()
      WHERE shipment_id = $1`,
        [shipmentId],
      );
    }

    await pool.query("COMMIT");
    res.json({ ok: true, message: "選択した出荷指示を完了しました" });
  } catch (err) {
    await pool.query("ROLLBACK");

    console.error(err);
    res.status(500).json({ error: "完了処理に失敗しました" });
  }
});

// 出荷指示の複数削除 API
app.post("/api/shipments/delete", authenticateToken, async (req, res) => {
  const { shipment_ids } = req.body;
  if (!shipment_ids || !Array.isArray(shipment_ids)) {
    return res.status(400).json({ error: "shipment_ids が必要です" });
  }
  try {
    await pool.query(`DELETE FROM shipments WHERE shipment_id = ANY($1)`, [
      shipment_ids,
    ]);
    res.json({ ok: true, message: "選択した出荷指示を削除しました" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "削除に失敗しました" });
  }
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
