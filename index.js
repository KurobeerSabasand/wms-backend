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
      "https://wms-frontend-vue.vercel.app",
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

// 商品マスタ
app.get("/api/master-products", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT product_code,product_name
      FROM master_products
      ORDER BY product_code ASC`,
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "商品マスタ取得に失敗しました: " + err.message });
  }
});

// 商品マスタ登録
app.post("/api/master-products", authenticateToken, async (req, res) => {
  const { product_code, product_name, barcode } = req.body;
  if (!product_code || !product_name) {
    return res
      .status(400)
      .json({ error: "product_code と product_name は必須です" });
  }
  try {
    await pool.query(
      `INSERT INTO master_products (product_code, product_name, barcode, created_at)
      VALUES ($1, $2, $3, NOW())`,
      [product_code, product_name, barcode || null],
    );
    res.json({ ok: true, message: "商品マスタを登録しました" });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "商品マスタ登録に失敗しました: " + err.message });
  }
});

// 在庫一覧ページを作る
// API化
app.get("/api/products", authenticateToken, async (req, res) => {
  const result = await pool.query("SELECT * FROM products");
  res.json(result.rows);
});

// 商品追加
app.post("/api/products/add-lot", authenticateToken, async (req, res) => {
  const { product_code, stock, stocked_at } = req.body;
  if (!product_code || !stock) {
    return res.status(400).json({ error: "product_code と stock は必須です" });
  }
  const stockedAt = stocked_at || new Date(); // 指定なければ現在時刻
  try {
    await pool.query(
      `INSERT INTO products (product_code, stock, allocatable_stock, stocked_at)
      VALUES ($1, $2, $2, $3)`,
      [product_code, stock, stockedAt],
    );
    res.json({ ok: true, message: "ロットを追加しました" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "ロット追加に失敗しました: " + err.message });
  }
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

// 引当API（allocate）
app.post("/api/shipments/allocate", authenticateToken, async (req, res) => {
  const { shipment_id } = req.body;
  if (!shipment_id) {
    return res.status(400).json({ error: "shipment_id が必要です" });
  }
  try {
    await pool.query("BEGIN");
    // 出荷指示の行を取得
    const lines = await pool.query(
      `SELECT product_code,quantity
      FROM shipments
      WHERE shipment_id = $1`,
      [shipment_id],
    );
    if (lines.rows.length === 0) {
      throw new Error("出荷指示が存在しません");
    }
    // まず全行の引当可能数チェック
    let canAllocate = true;
    for (const line of lines.rows) {
      const { product_code, quantity } = line;
      const stockRow = await pool.query(
        `SELECT SUM(allocatable_stock) AS alloc
        FROM products
        WHERE product_code = $1`,
        [product_code],
      );
      const allocatable = Number(stockRow.rows[0].alloc || 0);
      if (allocatable < quantity) {
        canAllocate = false;
        break;
      }
    }
    // 引当不可
    if (!canAllocate) {
      await pool.query(
        `UPDATE shipments
        SET status = 'unallocated',
          updated_at = NOW()
        WHERE shipment_id = $1`,
        [shipment_id],
      );
      await pool.query("COMMIT");
      return res.json({
        ok: false,
        status: "unallocated",
        message: "在庫不足のため引当できません",
      });
    }
    // 引当可能 → allocatable_stock を減らす
    for (const line of lines.rows) {
      const { product_code, quantity } = line;
      // FIFOロット順に allocatable_stock を減らす
      const lots = await pool.query(
        `SELECT product_code,allocatable_stock,stocked_at
        FROM products
        WHERE product_code = $1
        ORDER BY stocked_at ASC`,
        [product_code],
      );
      let remaining = quantity;
      for (const lot of lots.rows) {
        if (remaining <= 0) break;
        const deduct = Math.min(lot.allocatable_stock, remaining);
        remaining -= deduct;
        await pool.query(
          `UPDATE products
          SET allocatable_stock = allocatable_stock - $1,
            updated_at = NOW()
          WHERE product_code = $2 AND stocked_at = $3`,
          [deduct, product_code, lot.stocked_at],
        );
      }
    }
    // 出荷指示ステータスを allocated に更新
    await pool.query(
      `UPDATE shipments
      SET status = 'allocated',
        updated_at = NOW()
      WHERE shipment_id = $1`,
      [shipment_id],
    );
    await pool.query("COMMIT");
    res.json({
      ok: true,
      status: "allocated",
      message: "引当が完了しました",
    });
  } catch (err) {
    await pool.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "引当処理に失敗しました: " + err.message });
  }
});

// 再引当API（reallocate）
app.post("/api/shipments/reallocate", authenticateToken, async (req, res) => {
  const { shipmnent_id } = req.body;
  if (!shipmnent_id) {
    return res.status(400).json({ error: "shipment_id が必要です" });
  }
  try {
    await pool.query("BEGIN");
    // 出荷指示の行を取得
    const lines = await pool.query(
      `SELECT product_code,quantity
      FROM shipments
      WHERE shipment_id = $1`,
      [shipment_id],
    );
    if (lines.rows.length === 0) {
      throw new Error("出荷指示が存在しません");
    }
    // 現在のステータス確認
    const statusRow = await pool.query(
      `SELECT status FROM shipments WHERE shipment_id = $1 LIMIT 1`,
      [shipment_id],
    );
    const currentStatus = statusRow.rows[0].status;
    if (currentStatus === "completed") {
      throw new Error("出荷完了済みのため再引当できません");
    }
    if (currentStatus === "working") {
      throw new Error("作業中のため再引当できません");
    }
    // まず全行の引当可能数チェック
    let canAllocate = true;
    for (const line of lines.rows) {
      const { product_code, quantity } = line;
      const stockRow = await pool.query(
        `SELECT SUM(allocatable_stock) AS alloc
        FROM products
        WHERE product_code = $1`,
        [product_code],
      );
      const allocatable = Number(stockRow.rows[0].alloc || 0);
      if (allocatable <= quantity) {
        canAllocate = false;
        break;
      }
    }
    // 引当不可
    if (!canAllocate) {
      await pool.query(
        `UPDATE shipments
        SET status='unallocated',
          updated_at=NOW()
        WHERE shipment_id = $1`,
        [shipment_id],
      );
      await pool.query("COMMIT");
      return res.json({
        ok: false,
        status: "unallocated",
        message: "在庫不足のため再引当できません",
      });
    }
    // 引当可能 → allocatable_stock を減らす
    for (const line of lines.rows) {
      const { product_code, quantity } = line;
      // FIFOロット順に allocatable_stock を減らす
      const lots = await pool.query(
        `SELECT product_code,allocatable_stock,stocked_at
        FROM products
        WHERE product_code = $1
        ORDER BY stocked_at ASC`,
        [product_code],
      );
      let remaining = quantity;
      for (const lot of lots.rows) {
        if (remaining <= 0) break;
        const deduct = Math.min(lot.allocatable_stock, remaining);
        remaining -= deduct;
        await pool.query(
          `UPDATE products
          SET allocatable_stock = allocatable_stock - $1,
            updated_at = NOW()
          WHERE product_code = $2 AND stocked_at = $3`,
          [deduct, product_code, lot.stocked_at],
        );
      }
    }
    // 出荷指示ステータスを allocated に更新
    await pool.query(
      `UPDATE shipments
      SET status = 'allocated',
        updated_at = NOW()
      WHERE shipment_id = $1`,
      [shipment_id],
    );
    await pool.query("COMMIT");
    res.json({
      ok: true,
      status: "allocated",
      message: "再引当が完了しました",
    });
  } catch (err) {
    await pool.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "再引当処理に失敗しました: " + err.message });
  }
});

// 作業中API（start-work）
app.post("/api/shipments/start-work", authenticateToken, async (req, res) => {
  const { shipment_id } = req.body;
  if (!shipment_id) {
    return res.status(400).json({ error: "shipment_id が必要です" });
  }
  try {
    await pool.query("BEGIN");
    // 現在のステータスを確認
    const statusRow = await pool.query(
      `SELECT status FROM shipments WHERE shipment_id = $1 LIMIT 1`,
      [shipment_id],
    );
    if (statusRow.rows.length === 0) {
      throw new Error("出荷指示が存在しません");
    }
    const currentStatus = statusRow.rows[0].status;
    // allocated のみ作業中にできる
    if (currentStatus !== "allocated") {
      throw new Error("allocated の出荷指示のみ作業中にできます");
    }
    // 明細を取得
    const lines = await pool.query(
      `SELECT shipment_line_id,product_code,quantity
      FROM shipments
      WHERE shipment_id = $1`,
      [shipment_id],
    );
    // ロット確定（ピックリスト用）
    for (const line of lines.rows) {
      const { shipment_line_id, product_code, quantity } = line;
      let remaining = quantity;
      const lots = await pool.query(
        `SELECT product_code,allocatable_stock,stocked_at
        FROM products
        WHERE product_code = $1
        ORDER BY stocked_at ASC`,
        [product_code],
      );
      for (const lot of lots.rows) {
        if (remaining <= 0) break;
        const useQty = Math.min(lot.allocatable_stock, remaining);
        remaining -= useQty;
        // ピックリスト用ロット確定テーブルに保存
        await pool.query(
          `INSERT INTO shipment_allocations (
            shipment_id,
            shipment_line_id,
            product_code,
            stocked_at,
            allocated_qty
          ) VALUES ($1, $2, $3, $4, $5)`,
          [shipment_id, shipment_line_id, product_code, lot.stocked_at, useQty],
        );
      }
      if (remaining > 0) {
        throw new Error(`ロット不足: ${product_code}`);
      }
    }
    // 作業中に更新
    await pool.query(
      `UPDATE shipments
      SET status = 'working',
        updated_at = NOW()
      WHERE shipment_id = $1`,
      [shipment_id],
    );
    await pool.query("COMMIT");
    res.json({
      ok: true,
      status: "working",
      message: "作業中ステータスに変更し、ロットを確定しました",
    });
  } catch (err) {
    await pool.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "作業中処理に失敗しました: " + err.message });
  }
});

// ピックリストAPI
app.get(
  "/api/shipments/:shipment_id/pickList",
  authenticateToken,
  async (req, res) => {
    const shipment_id = req.params.shipment_id;
    try {
      // ステータス確認（作業中のみピックリストを表示）
      const statusRow = await pool.query(
        `SELECT status FROM shipments WHERE shipment_id = $1 LIMIT 1`,
        [shipment_id],
      );
      if (statusRow.rows.length === 0) {
        return res.status(404).json({ error: "出荷指示が存在しません" });
      }
      const status = statusRow.rows[0].status;
      if (status !== "working") {
        return res.status(400).json({
          error: "作業中ステータスの出荷指示のみピックリストを表示できます",
        });
      }
      // ロット確定情報を取得
      const result = await pool.query(
        `SELECT
          shipment_line_id,
          product_code,
          stocked_at,
          allocated_qty
        FROM shipment_allocations
        WHERE shipment_id = $1
        ORDER BY shipment_line_id,stocked_at ASC`,
        [shipment_id],
      );
      res.json(result.rows);
    } catch (err) {
      console.error(err);
      res
        .status(500)
        .json({ error: "ピックリスト取得に失敗しました: " + err.message });
    }
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
      // ステータス確認（working のみ完了可能）
      const statusRow = await pool.query(
        `SELECT status FROM shipments WHERE shipment_id = $1 LIMIT 1`,
        [shipmentId],
      );
      if (statusRow.rows.length === 0) {
        throw new Error(`shipment_id ${shipmentId} が存在しません`);
      }
      const currentStatus = statusRow.rows[0].status;
      if (currentStatus !== "working") {
        throw new Error(
          `shipment_id ${shipmentId} は作業中ではないため出荷完了できません`,
        );
      }
      // ピックリスト（ロット確定情報）を取得
      const allocations = await pool.query(
        `SELECT
          shipment_line_id,
          product_code,
          stocked_at,
          allocated_qty
        FROM shipment_allocations
        WHERE shipment_id = $1
        ORDER BY shipment_line_id,stocked_at ASC`,
        [shipmentId],
      );
      if (allocations.rows.length === 0) {
        throw new Error(
          `shipment_id ${shipmentId} のロット確定情報がありません`,
        );
      }
      // ピックリストに従って stock を減らす
      for (const alloc of allocations.rows) {
        const { product_code, stocked_at, allocated_qty } = alloc;
        // ロットの stock を減らす
        await pool.query(
          `UPDATE products
          SET stock = stock - $1,updated_at = now()
          WHERE product_code = $2 AND stocked_at = $3`,
          [allocated_qty, product_code, stocked_at],
        );
        // 在庫が 0 になったロットは削除
        await pool.query(
          `DELETE FROM products
          WHERE product_code = $1 AND stocked_at = $2 AND stock = 0`,
          [product_code, stocked_at],
        );
      }
      // 出荷指示ステータス更新
      await pool.query(
        `UPDATE shipments
        SET status = 'completed',updated_at = NOW()
        WHERE shipment_id = $1`,
        [shipmentId],
      );
    }
    await pool.query("COMMIT");
    res.json({ ok: true, message: "選択した出荷指示を完了しました" });
  } catch (err) {
    await pool.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "出荷完了処理に失敗しました" });
  }
});

// 出荷指示の複数削除 API
app.post("/api/shipments/delete", authenticateToken, async (req, res) => {
  const { shipment_ids } = req.body;
  if (!shipment_ids || !Array.isArray(shipment_ids)) {
    return res.status(400).json({ error: "shipment_ids が必要です" });
  }
  try {
    await pool.query("BEGIN");
    for (const shipmentId of shipment_ids) {
      // ステータス確認
      const statusRow = await pool.query(
        `SELECT status FROM shipments WHERE shipment_id = $1 LIMIT 1`,
        [shipmentId],
      );
      if (statusRow.rows.length === 0) {
        throw new Error(`shipment_id ${shipmentId} が存在しません`);
      }
      const status = statusRow.rows[0].status;
      // compleded は削除不可
      if (status === "completed") {
        throw new Error(
          `shipment_id ${shipmentId} は出荷完了済みのため削除できません`,
        );
      }
      // allocated または working の場合は allocatable_stock を戻す
      if (status === "allocated" || status === "working") {
        // ロット確定情報がある場合（working）
        const allocations = await pool.query(
          `SELECT product_code,stocked_at,allocated_qty
          FROM shipment_allocations
          WHERE shipment_id = $1`,
          [shipmentId],
        );
        if (allocations.rows.length > 0) {
          // working の場合：ロット確定情報を使って戻す
          for (const alloc of allocations.rows) {
            const { product_code, stocked_at, allocated_qty } = alloc;
            await pool.query(
              `UPDATE products
              SET allocatable_stock = allocatable_stock + $1,updated_at = NOW()
              WHERE product_code = $2 AND stocked_at = $3`,
              [allocated_qty, product_code, stocked_at],
            );
          }
          // ロット確定情報を削除
          await pool.query(
            `DELETE FROM shipment_allocations
            WHERE shipment_id = $1`,
            [shipmentId],
          );
        } else {
          // allocated の場合：引当APIと同じロジックで戻す
          const lines = await pool.query(
            `SELECT product_code,quantity
            FROM shipments
            WHERE shipment_id = $1`,
            [shipmentId],
          );
          for (const line of lines.rows) {
            const { product_code, quantity } = line;
            let remaining = quantity;
            const lots = await pool.query(
              `SELECT product_code,allocatable_stock,stocked_at
              FROM products
              WHERE product_code = $1
              ORDER BY stocked_at ASC`,
              [product_code],
            );
            for (const lot of lots.rows) {
              if (remaining <= 0) break;
              const addQty = Math.min(quantity, remaining);
              remaining -= addQty;
              await pool.query(
                `UPDATE products
                SET allocatable_stock = allocatable_stock + $1,updated_at = NOW()
                WHERE product_code = $2 AND stocked_at = $3`,
                [addQty, product_code, lot.stocked_at],
              );
            }
          }
        }
      }
      // shipments の行を削除
      await pool.query(`DELETE FROM shipments WHERE shipment_id = $1`, [
        shipmentId,
      ]);
    }
    await pool.query("COMMIT");
    res.json({
      ok: true,
      message: "選択した出荷指示を削除しました",
    });
  } catch (err) {
    await pool.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "削除処理に失敗しました: " + err.message });
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
