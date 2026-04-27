import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import session from 'express-session';
import SQLiteStore from 'connect-sqlite3';
// bcrypt removed: authentication is handled by Supabase now
import { open } from 'sqlite';
import multer from 'multer';
import sqlite3 from 'sqlite3';
import ViabilityCalculator from './services/ViabilityCalculator.js'; // Force restart
import { body, validationResult } from 'express-validator';
// import { createClient } from '@supabase/supabase-js'; // Removed
import nodemailer from 'nodemailer';
import { scrypt, randomBytes, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import puppeteer from 'puppeteer';

const scryptAsync = promisify(scrypt);

// ========================================
// OTIMIZAÇÕES FASE 1 - Imports
// ========================================
import compression from 'compression';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import morgan from 'morgan';
// ========================================

// ========================================
// SEGURANÇA AVANÇADA - Imports
// ========================================
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';
// ========================================

const app = express();
app.set('trust proxy', 1); // Apenas 1 proxy à frente (Nginx) - corrige ERR_ERL_PERMISSIVE_TRUST_PROXY
console.log('✅ Trust Proxy habilitado para EasyPanel');
const PORT = process.env.PORT || 3000;

// --- Proxy para Caixa (Bypass X-Frame-Options) ---

const caixaProxyOptions = {
    target: 'https://venda-imoveis.caixa.gov.br',
    changeOrigin: true,
    secure: false,
    onProxyReq: function (proxyReq, req, res) {
        proxyReq.setHeader('Referer', 'https://venda-imoveis.caixa.gov.br/sistema/busca-imovel.asp');
        proxyReq.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    },
    onProxyRes: function (proxyRes, req, res) {
        delete proxyRes.headers['x-frame-options'];
        delete proxyRes.headers['content-security-policy'];
        if (proxyRes.headers['set-cookie']) {
            proxyRes.headers['set-cookie'] = proxyRes.headers['set-cookie'].map(cookie => {
                return cookie.replace(/Domain=[^;]+;/, '').replace(/Secure;/, '');
            });
        }
    }
};

app.use('/sistema', createProxyMiddleware({
    ...caixaProxyOptions,
    pathRewrite: { '^/': '/sistema/' }
}));

// Proxy para recursos estáticos (Imagens, CSS, JS que estejam na raiz)
app.use('/fotos', createProxyMiddleware(caixaProxyOptions));
app.use('/imagens', createProxyMiddleware(caixaProxyOptions));
app.use('/assets', createProxyMiddleware(caixaProxyOptions));
app.use('/fotos/*', createProxyMiddleware(caixaProxyOptions)); // Tentativa de capturar subpastas de fotos
app.use('/imagens/*', createProxyMiddleware(caixaProxyOptions));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Conexão com o Banco de Dados ---
const db = await open({
    filename: path.join(__dirname, './db/database.sqlite'),
    driver: sqlite3.Database
});

// ========================================
// OTIMIZAÇÕES SQLITE - Performance
// ========================================
console.log('⚙️  Configurando otimizações do SQLite...');
await db.run('PRAGMA journal_mode = WAL'); // Write-Ahead Logging
await db.run('PRAGMA synchronous = NORMAL'); // Menos fsync
await db.run('PRAGMA cache_size = -64000'); // 64MB de cache
await db.run('PRAGMA temp_store = MEMORY'); // Temp em RAM
await db.run('PRAGMA mmap_size = 30000000000'); // Memory-mapped I/O
await db.run('PRAGMA page_size = 4096'); // Tamanho de página otimizado
console.log('✅ SQLite otimizado com WAL mode e cache aumentado');
// ========================================

// --- Middlewares ---

// ========================================
// OTIMIZAÇÕES FASE 1 - Middlewares
// ========================================

// 1. Compressão GZIP
app.use(compression({
    level: 6, // Nível de compressão (0-9, 6 é bom balanço)
    threshold: 1024, // Só comprimir respostas > 1KB
    filter: (req, res) => {
        if (req.headers['x-no-compression']) {
            return false;
        }
        return compression.filter(req, res);
    }
}));
console.log('✅ Compressão GZIP ativada');

// 2. Helmet - Segurança
app.use(helmet({
    contentSecurityPolicy: false, // DESABILITADO TEMPORARIAMENTE PARA DEBUG
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));
console.log('✅ Helmet (segurança) ativado - CSP DESABILITADO para debug');

// 3. Logging
if (process.env.NODE_ENV === 'production') {
    app.use(morgan('combined')); // Log completo em produção
    console.log('✅ Logging (production mode) ativado');
} else {
    app.use(morgan('dev')); // Log simplificado em desenvolvimento
    console.log('✅ Logging (dev mode) ativado');
}

// ========================================

// ========================================
// SEGURANÇA AVANÇADA - Middlewares
// ========================================

// 4. CORS - Controle de Acesso
const corsOptions = {
    origin: true, // Permitir todas as origens em desenvolvimento
    credentials: true,
    optionsSuccessStatus: 200,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept']
};

app.use(cors(corsOptions));
console.log('✅ CORS configurado - PERMISSIVO para debug');

// 5. Proteção contra poluição de parâmetros HTTP
app.use((req, res, next) => {
    // Limitar tamanho de arrays em query strings
    for (const key in req.query) {
        if (Array.isArray(req.query[key]) && req.query[key].length > 10) {
            return res.status(400).json({ error: 'Muitos parâmetros na query string' });
        }
    }
    next();
});

// 6. Sanitização básica de inputs
const sanitizeInput = (str) => {
    if (typeof str !== 'string') return str;
    // Remove caracteres perigosos
    return str
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/javascript:/gi, '')
        .replace(/on\w+\s*=/gi, '')
        .trim();
};

app.use((req, res, next) => {
    // Sanitizar body
    if (req.body && typeof req.body === 'object') {
        for (const key in req.body) {
            if (typeof req.body[key] === 'string') {
                req.body[key] = sanitizeInput(req.body[key]);
            }
        }
    }

    // Sanitizar query params
    if (req.query && typeof req.query === 'object') {
        for (const key in req.query) {
            if (typeof req.query[key] === 'string') {
                req.query[key] = sanitizeInput(req.query[key]);
            }
        }
    }

    next();
});
console.log('✅ Sanitização de inputs ativada');

// 8. Headers de segurança adicionais
app.use((req, res, next) => {
    // HSTS - Force HTTPS em produção
    if (process.env.NODE_ENV === 'production') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    }

    // Permissive CSP for Preview and External Assets (Required for Da Vinci and Maps)
    res.setHeader("Content-Security-Policy", "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src * 'unsafe-inline' 'unsafe-eval'; style-src * 'unsafe-inline' 'unsafe-eval'; img-src * data: blob:; font-src *; connect-src *; frame-src *;");

    // Referrer Policy
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    // Permissions Policy
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

    // X-Permitted-Cross-Domain-Policies
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');

    // Cache Control para páginas sensíveis
    if (req.path.includes('/perfil') || req.path.includes('/admin')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }

    next();
});
console.log('✅ Headers de segurança adicionais configurados');

// 8. Proteção contra timing attacks em comparações
const crypto = await import('crypto');
const safeCompare = (a, b) => {
    try {
        return crypto.timingSafeEqual(
            Buffer.from(String(a)),
            Buffer.from(String(b))
        );
    } catch {
        return false;
    }
};

// Disponibilizar globalmente
app.locals.safeCompare = safeCompare;

// ========================================

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' })); // Limite aumentado para geração de PDF com imagens
app.use(express.urlencoded({ extended: true, limit: '50mb' })); // Limite aumentado para form data

// ========================================
// API DE GERAÇÃO DE PDF (PUPPETEER) - Backend sólido e sem erros de layout
// ========================================
app.post('/api/generate-pdf', async (req, res) => {
    let browser;
    try {
        const { html, filename = 'proposta.pdf' } = req.body;
        if (!html) {
            return res.status(400).json({ error: 'HTML é obrigatório' });
        }

        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 794, height: 1123 }); // A4 em 96dpi
        await page.emulateMediaType('print');

        // Injeta o HTML completo e aguarda recursos (imagens, fontes) carregarem
        await page.setContent(html, { waitUntil: 'networkidle0', timeout: 45000 });

        // Aguarda fontes do Google Fonts renderizarem
        await page.evaluate(() => document.fonts.ready);

        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
            preferCSSPageSize: true
        });

        await browser.close();

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
        res.setHeader('Content-Length', pdfBuffer.length);
        res.end(pdfBuffer);

    } catch (error) {
        if (browser) await browser.close().catch(() => {});
        console.error('❌ Erro ao gerar PDF via Puppeteer:', error);
        res.status(500).json({ error: 'Erro interno ao gerar o PDF. Tente novamente.' });
    }
});
console.log('✅ API de geração de PDF (Puppeteer) ativada em POST /api/generate-pdf');
// ========================================

// --- Configuração do Multer para Upload de Arquivos ---
// Tipos de arquivo permitidos
const ALLOWED_FILE_TYPES = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'application/pdf': '.pdf'
};

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'public/uploads/'); // Garanta que a pasta 'public/uploads' exista
    },
    filename: function (req, file, cb) {
        // Sanitizar nome do arquivo
        const sanitizedOriginalName = path.basename(file.originalname)
            .replace(/[^a-zA-Z0-9.-]/g, '_') // Remove caracteres especiais
            .substring(0, 100); // Limita tamanho do nome

        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = ALLOWED_FILE_TYPES[file.mimetype] || path.extname(sanitizedOriginalName);

        cb(null, `${req.session.userId}-${uniqueSuffix}${ext}`);
    }
});

// Filtro de arquivos
const fileFilter = (req, file, cb) => {
    // Verificar tipo MIME
    if (ALLOWED_FILE_TYPES[file.mimetype]) {
        cb(null, true);
    } else {
        cb(new Error(`Tipo de arquivo não permitido: ${file.mimetype}. Apenas imagens e PDFs são aceitos.`), false);
    }
};

const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 10 * 1024 * 1024, // Aumentado para 10MB
        files: 20, // Aumentado para 20
        fields: 100 // Limite de campos de texto
    }
});

console.log('✅ Upload de arquivos configurado com segurança');

// --- Configuração da Sessão ---
const SQLiteStoreSession = SQLiteStore(session);
app.use(session({
    store: new SQLiteStoreSession({
        db: 'database.sqlite',
        dir: path.join(__dirname, 'db'),
        table: 'sessions'
    }),
    secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    name: 'arremata.sid', // Nome customizado do cookie (dificulta ataques)
    cookie: {
        maxAge: 7 * 24 * 60 * 60 * 1000, // 1 semana
        httpOnly: true, // Não acessível via JavaScript (proteção XSS)
        secure: process.env.NODE_ENV === 'production', // HTTPS apenas em produção
        sameSite: 'strict', // Proteção CSRF
        path: '/'
    },
    rolling: true // Renova o cookie a cada requisição (mantém sessão ativa)
}));

console.log('✅ Sessão configurada com segurança');

// --- Configuração do Template Engine ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Expor chaves necessárias para views (APENAS a anon key será usada no cliente)
app.use((req, res, next) => {
    // --- BYPASS LOGIN (Sempre Autenticado) ---
    if (!req.session.userId) {
        req.session.userId = 1;
        req.session.username = 'Usuário Master';
        req.session.email = 'arremataapp@gmail.com';
        req.session.isAdmin = true;
    }
    
    // Se tentar acessar o login ou registro, redireciona para a home
    if (req.path === '/login' || req.path === '/register') {
        return res.redirect('/');
    }

    res.locals.supabaseUrl = '';
    res.locals.supabaseAnonKey = '';
    res.locals.username = req.session?.username || '';
    res.locals.email = req.session?.email || '';
    res.locals.profile_pic_url = req.session?.profile_pic_url || '';
    res.locals.isAdmin = req.session?.isAdmin || false;
    next();
});


// --- Auto-migrations (simples) ---
async function ensureTables() {
    console.log('⚙️  Verificando integridade do banco de dados...');

    // 1. Tabela Users
    const tblUsers = await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='users'");
    if (!tblUsers) {
        console.log('Criando tabela users...');
        await db.run(`CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT,
            password TEXT,
            profile_pic_url TEXT,
            email TEXT,
            supabase_id TEXT,
            is_admin INTEGER DEFAULT 0,
            supabase_metadata TEXT
        )`);
    } else {
        // Checa colunas e adiciona se necessário
        const cols = await db.all("PRAGMA table_info('users')");
        const colNames = cols.map(c => c.name);
        if (!colNames.includes('email')) await db.run("ALTER TABLE users ADD COLUMN email TEXT");
        if (!colNames.includes('supabase_id')) await db.run("ALTER TABLE users ADD COLUMN supabase_id TEXT");
        if (!colNames.includes('is_admin')) await db.run("ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0");
        if (!colNames.includes('supabase_metadata')) await db.run("ALTER TABLE users ADD COLUMN supabase_metadata TEXT");
    }
    await db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_supabase_id ON users(supabase_id)");
    await db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)");

    // 2. Tabela Saved Calculations
    await db.run(`CREATE TABLE IF NOT EXISTS saved_calculations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        name TEXT,
        data TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 3. Tabela Arremates
    await db.run(`CREATE TABLE IF NOT EXISTS arremates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        descricao_imovel TEXT,
        endereco TEXT,
        data_arremate DATE,
        valor_arremate REAL,
        leiloeiro TEXT,
        edital TEXT,
        calc_valor_avaliacao REAL,
        calc_custo_itbi REAL,
        calc_custo_registro REAL,
        calc_custo_leiloeiro REAL,
        calc_custo_reforma REAL,
        calc_outros_custos REAL,
        calc_valor_venda REAL,
        calc_custo_corretagem REAL,
        calc_imposto_ganho_capital REAL,
        calc_lucro_liquido REAL,
        calc_roi_liquido REAL
    )`);

    // 4. Tabela de Clientes (Assessorados)
    await db.run(`CREATE TABLE IF NOT EXISTS clientes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        assessor_id INTEGER NOT NULL,
        nome TEXT NOT NULL,
        cpf TEXT,
        email TEXT,
        telefone TEXT,
        status TEXT DEFAULT 'ativo',
        data_inicio DATE,
        observacoes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(assessor_id) REFERENCES users(id) ON DELETE CASCADE
    )`);

    // 5. Tabelas da Carteira
    await db.run(`CREATE TABLE IF NOT EXISTS carteira_imoveis (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        descricao TEXT,
        endereco TEXT,
        valor_compra REAL,
        data_aquisicao DATE,
        valor_venda_estimado REAL,
        status TEXT DEFAULT 'Arrematado'
    )`);

    // MIGRATION: Ensure columns exist (for existing databases)
    try {
        const tableInfo = await db.all("PRAGMA table_info(carteira_imoveis)");
        const columns = tableInfo.map(c => c.name);
        if (!columns.includes('condominio_estimado')) {
            await db.run("ALTER TABLE carteira_imoveis ADD COLUMN condominio_estimado REAL DEFAULT 0");
            console.log('✅ Coluna condominio_estimado adicionada.');
        }
        if (!columns.includes('iptu_estimado')) {
            await db.run("ALTER TABLE carteira_imoveis ADD COLUMN iptu_estimado REAL DEFAULT 0");
            console.log('✅ Coluna iptu_estimado adicionada.');
        }
        if (!columns.includes('cliente_id')) {
            await db.run("ALTER TABLE carteira_imoveis ADD COLUMN cliente_id INTEGER REFERENCES clientes(id) ON DELETE CASCADE");
            console.log('✅ Coluna cliente_id adicionada à carteira_imoveis.');
        }
        if (!columns.includes('lucro_estimado')) {
            await db.run("ALTER TABLE carteira_imoveis ADD COLUMN lucro_estimado REAL DEFAULT 0");
        }
        if (!columns.includes('minerador_original_id')) {
            await db.run("ALTER TABLE carteira_imoveis ADD COLUMN minerador_original_id INTEGER DEFAULT NULL");
            console.log('✅ Coluna minerador_original_id adicionada.');
        }
        if (!columns.includes('roi_estimado')) {
            await db.run("ALTER TABLE carteira_imoveis ADD COLUMN roi_estimado REAL DEFAULT 0");
            console.log('✅ Coluna roi_estimado adicionada à carteira_imoveis.');
        }
    } catch (e) {
        console.error('Erro na migração de carteira_imoveis:', e);
    }

    await db.run(`CREATE TABLE IF NOT EXISTS carteira_custos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        imovel_id INTEGER,
        tipo_custo TEXT,
        valor REAL,
        data_custo DATE,
        descricao TEXT
    )`);



    // 6. Tabela Invites
    await db.run(`CREATE TABLE IF NOT EXISTS invites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT,
        token TEXT,
        created_by INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME,
        used INTEGER DEFAULT 0
    )`);

    // 7. Tabela Configurações do Sistema (Admin)
    await db.run(`CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )`);




    console.log('✅ Tabelas verificadas/criadas com sucesso.');

    // --- MIGRATIONS ADICIONAIS (originadas de initializeDatabase) ---
    // Garantir colunas na tabela arremates
    try {
        const arrematesInfo = await db.all("PRAGMA table_info(arremates)");
        const arrematesColumns = arrematesInfo.map(c => c.name);
        const calcColumns = [
            'calc_valor_avaliacao', 'calc_custo_itbi', 'calc_custo_registro', 'calc_custo_leiloeiro',
            'calc_custo_reforma', 'calc_outros_custos', 'calc_valor_venda', 'calc_custo_corretagem',
            'calc_imposto_ganho_capital', 'calc_lucro_liquido', 'calc_roi_liquido'
        ];

        for (const colName of calcColumns) {
            if (!arrematesColumns.includes(colName)) {
                await db.exec(`ALTER TABLE arremates ADD COLUMN ${colName} REAL`);
                console.log(`✅ Coluna "${colName}" adicionada à tabela de arremates.`);
            }
        }
    } catch (e) {
        console.error('Erro na migração de arremates:', e);
    }

    // Garantir colunas na tabela carteira_imoveis
    try {
        const carteiraInfo = await db.all("PRAGMA table_info(carteira_imoveis)");
        const carteiraCols = carteiraInfo.map(c => c.name);
        const newCols = [
            { name: 'condominio_estimado', type: 'REAL DEFAULT 0' },
            { name: 'iptu_estimado', type: 'REAL DEFAULT 0' },
            { name: 'observacoes', type: 'TEXT' },
            { name: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' }
        ];

        for (const col of newCols) {
            if (!carteiraCols.includes(col.name)) {
                await db.exec(`ALTER TABLE carteira_imoveis ADD COLUMN ${col.name} ${col.type}`);
                console.log(`✅ Coluna "${col.name}" adicionada à tabela carteira_imoveis.`);
            }
        }
    } catch (e) {
        console.error('Erro na migração de carteira_imoveis (extra):', e);
    }

    // Tabela de Leads (Funil de Vendas)
    await db.exec(`
        CREATE TABLE IF NOT EXISTS leads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nome TEXT,
            whatsapp TEXT,
            
            -- Dados de Qualificação
            objetivo TEXT, -- 'morar' | 'investir'
            experiencia TEXT, -- 'primeira_vez' | 'experiente'
            restricao_nome BOOLEAN, -- 1 (sujo) | 0 (limpo)
            
            -- Financeiro
            capital_entrada REAL,
            capital_vista REAL,
            preferencia_pgto TEXT, -- 'vista' | 'financiado'
            
            -- Localização
            estado TEXT,
            cidade TEXT,

            -- Produto de Interesse
            interesse TEXT DEFAULT 'nao_informado', -- 'assessoria' | 'mentoria_online' | 'mentoria_individual' | 'licenciado' | 'promotor' | 'eventos'

            -- Metadados
            score INTEGER DEFAULT 0,
            status TEXT DEFAULT 'novo', -- 'novo', 'contatado', 'convertido', 'desqualificado'
            claimed_by INTEGER, -- ID do assessor que pegou o lead
            
            -- Segurança
            ip_address TEXT,
            fingerprint TEXT,
            
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Migração automática: garante coluna 'interesse' em bancos existentes
    try {
        const leadsCols = (await db.all(`PRAGMA table_info(leads)`)).map(c => c.name);
        if (!leadsCols.includes('interesse')) {
            await db.exec(`ALTER TABLE leads ADD COLUMN interesse TEXT DEFAULT 'nao_informado'`);
            console.log('✅ Coluna "interesse" adicionada à tabela leads.');
        }
    } catch(e) {
        console.error('Migração leads (interesse):', e.message);
    }

    // Tabela de Oportunidades (Imóveis Estudados)
    await db.exec(`
        CREATE TABLE IF NOT EXISTS oportunidades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER, -- Assessor que cadastrou
            titulo TEXT,
            descricao TEXT,
            
            -- Dados Principais
            valor_arremate REAL,
            valor_venda REAL,
            lucro_estimado REAL,
            roi_estimado REAL,
            cidade TEXT,
            estado TEXT,
            latitude REAL, -- Geo
            longitude REAL, -- Geo
            tipo_imovel TEXT, -- Casa, Apto, etc
            
            -- Links e Midia
            link_caixa TEXT,
            foto_capa TEXT,
            pdf_proposta TEXT,
            pdf_matricula TEXT,
            
            -- Integração
            calculo_origem_id INTEGER, -- ID do cálculo salvo que gerou isso (opcional)
            
            status TEXT DEFAULT 'disponivel', -- disponivel, reservado, vendido
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Migração para adicionar colunas de localização se não existirem em saved_calculations (para facilitar importação)
    try {
        await db.exec("ALTER TABLE saved_calculations ADD COLUMN cidade TEXT");
        console.log("Coluna 'cidade' adicionada à tabela saved_calculations.");
    } catch (e) {
        // Ignora se já existir
    }

    // Migrações para adicionar IP e Fingerprint à tabela leads existente
    try {
        await db.exec("ALTER TABLE leads ADD COLUMN ip_address TEXT");
        console.log("Coluna 'ip_address' adicionada à tabela leads.");
    } catch (e) { }

    try {
        await db.exec("ALTER TABLE leads ADD COLUMN fingerprint TEXT");
        console.log("Coluna 'fingerprint' adicionada à tabela leads.");
    } catch (e) { }

    // Migração para adicionar coluna 'interesse' se não existir
    try {
        await db.exec("ALTER TABLE leads ADD COLUMN interesse TEXT");
        console.log("Coluna 'interesse' adicionada à tabela leads.");
    } catch (e) {
        // Ignora erro se coluna já existir
    }

    // Migração para adicionar 'pdf_analise_juridica' em oportunidades
    try {
        await db.exec("ALTER TABLE oportunidades ADD COLUMN pdf_analise_juridica TEXT");
        console.log("Coluna 'pdf_analise_juridica' adicionada à tabela oportunidades.");
    } catch (e) { }

    // Limpeza de tabelas antigas
    await db.exec('DROP TABLE IF EXISTS carteira_entries');
}

await ensureTables();

// ========================================
// CRIAÇÃO DE ÍNDICES - Performance
// ========================================
async function createIndexes() {
    console.log('📊 Criando índices para otimização...');

    try {
        // Índices para arremates
        await db.run('CREATE INDEX IF NOT EXISTS idx_arremates_user_id ON arremates(user_id)');
        await db.run('CREATE INDEX IF NOT EXISTS idx_arremates_data ON arremates(data_arremate DESC)');

        // Índices para clientes
        await db.run('CREATE INDEX IF NOT EXISTS idx_clientes_assessor ON clientes(assessor_id)');
        await db.run('CREATE INDEX IF NOT EXISTS idx_clientes_status ON clientes(status)');
        await db.run('CREATE INDEX IF NOT EXISTS idx_clientes_cpf ON clientes(cpf)');

        // Índices para carteira
        await db.run('CREATE INDEX IF NOT EXISTS idx_carteira_imoveis_user_id ON carteira_imoveis(user_id)');
        await db.run('CREATE INDEX IF NOT EXISTS idx_carteira_imoveis_cliente ON carteira_imoveis(cliente_id)');
        await db.run('CREATE INDEX IF NOT EXISTS idx_carteira_assessor_cliente ON carteira_imoveis(user_id, cliente_id)');
        await db.run('CREATE INDEX IF NOT EXISTS idx_carteira_custos_imovel_id ON carteira_custos(imovel_id)');
        await db.run('CREATE INDEX IF NOT EXISTS idx_carteira_custos_user_id ON carteira_custos(user_id)');

        // Índices para cálculos salvos
        await db.run('CREATE INDEX IF NOT EXISTS idx_saved_calculations_user_id ON saved_calculations(user_id)');
        await db.run('CREATE INDEX IF NOT EXISTS idx_saved_calculations_created ON saved_calculations(created_at DESC)');



        // Índices para invites
        await db.run('CREATE INDEX IF NOT EXISTS idx_invites_token ON invites(token)');

        // Migração: Atualizar status de imóveis de 'Em Análise' para 'Arrematado'
        const result = await db.run(
            "UPDATE carteira_imoveis SET status = 'Arrematado' WHERE status = 'Em Análise' OR status IS NULL"
        );

        if (result.changes > 0) {
            console.log(`✅ Migração: ${result.changes} imóvel(is) atualizado(s) para status 'Arrematado'`);
        }

        // Migração: Criar cliente padrão para cada assessor e vincular imóveis órfãos
        const assessores = await db.all("SELECT DISTINCT user_id FROM carteira_imoveis WHERE cliente_id IS NULL");

        for (const assessor of assessores) {
            if (!assessor.user_id) continue;

            // Verificar se já existe cliente padrão para este assessor
            const clienteExistente = await db.get(
                "SELECT id FROM clientes WHERE assessor_id = ? AND nome = 'Carteira Principal'",
                [assessor.user_id]
            );

            let clienteId;
            if (!clienteExistente) {
                // Criar cliente padrão
                const resultCliente = await db.run(
                    `INSERT INTO clientes (assessor_id, nome, status, data_inicio, observacoes) 
                     VALUES (?, 'Carteira Principal', 'ativo', date('now'), 'Carteira criada automaticamente na migração')`,
                    [assessor.user_id]
                );
                clienteId = resultCliente.lastID || resultCliente.stmt?.lastID;
                console.log(`✅ Cliente padrão criado para assessor ${assessor.user_id}`);
            } else {
                clienteId = clienteExistente.id;
            }

            // Vincular imóveis órfãos ao cliente padrão
            const resultVinculo = await db.run(
                "UPDATE carteira_imoveis SET cliente_id = ? WHERE user_id = ? AND cliente_id IS NULL",
                [clienteId, assessor.user_id]
            );

            if (resultVinculo.changes > 0) {
                console.log(`✅ ${resultVinculo.changes} imóvel(is) vinculado(s) ao cliente padrão do assessor ${assessor.user_id}`);
            }
        }

        console.log('✅ Índices criados com sucesso');
    } catch (error) {
        console.error('❌ Erro ao criar índices:', error);
    }
}

await createIndexes();

// ========================================
// RECOVERY: Garantir usuário admin no startup (VPS fix) moved down
// ========================================

// Helper: parse list of admin emails from env (comma separated)
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// --- Password Security Helpers ---
const hashPassword = async (password) => {
    const salt = randomBytes(16).toString('hex');
    const derivedKey = await scryptAsync(password, salt, 64);
    return `${salt}:${derivedKey.toString('hex')}`;
};

const verifyPassword = async (password, storedHash) => {
    if (!storedHash) return false;
    const [salt, key] = storedHash.split(':');
    if (!salt || !key) return false;
    const keyBuffer = Buffer.from(key, 'hex');
    const derivedKey = await scryptAsync(password, salt, 64);
    return timingSafeEqual(keyBuffer, derivedKey);
};

// ========================================
// RECOVERY: Garantir usuário admin no startup (VPS fix)
// ========================================
async function ensureAdminUser() {
    console.log('🛡️ Verificando usuário admin padrão...');
    const email = 'arremataapp@gmail.com';

    try {
        // Gera o hash da senha solicitada: 35153515
        const hashedPassword = await hashPassword('35153515');

        const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
        if (!user) {
            console.log('⚠️ Admin não encontrado. Criando...');
            await db.run('INSERT INTO users (username, password, email, is_admin, profile_pic_url) VALUES (?, ?, ?, 1, NULL)',
                ['Admin Arremata', hashedPassword, email]);
        } else {
            // Força a atualização da senha para garantir que o login funcione
            console.log('🔄 Atualizando credenciais do admin para garantir acesso...');
            await db.run('UPDATE users SET password = ?, is_admin = 1 WHERE email = ?', [hashedPassword, email]);
        }
        console.log('✅ Admin padrão configurado/restaurado com sucesso.');
    } catch (e) {
        console.error('❌ Erro ao configurar admin padrão:', e);
    }
}

async function ensureSecondaryUser() {
    console.log('🛡️ Verificando usuário secundário (Chefia)...');
    const email = 'fortalestrutura@gmail.com';
    const username = 'Gestão Leads';

    try {
        const hashedPassword = await hashPassword('35153515');
        const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
        if (!user) {
            console.log('✨ Criando usuário secundário...');
            await db.run('INSERT INTO users (username, password, email, is_admin) VALUES (?, ?, ?, 0)',
                [username, hashedPassword, email]);
        } else {
            console.log('🔄 Atualizando usuário secundário...');
            await db.run('UPDATE users SET password = ?, is_admin = 0, username = ? WHERE email = ?',
                [hashedPassword, username, email]);
        }
        console.log('✅ Usuário secundário configurado com sucesso.');
    } catch (e) {
        console.error('❌ Erro ao configurar usuário secundário:', e);
    }
}

await ensureAdminUser();
await ensureSecondaryUser();
// ========================================

// --- Middleware de Autenticação (Bypass Ativado) ---
const isAuthenticated = (req, res, next) => {
    return next();
};

// Helper para criar contexto de usuário consistente
const getUserContext = (session) => {
    return {
        username: session.username || 'Usuário',
        email: session.email || 'Sem email',
        profile_pic_url: session.profile_pic_url || null,
        isAdmin: session.isAdmin || false
    };
};

// ========================================
// RATE LIMITING - Proteção contra abuso
// ========================================

// Rate limiter para rotas de API
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 100, // 100 requisições por IP
    message: 'Muitas requisições deste IP, tente novamente em 15 minutos.',
    standardHeaders: true,
    legacyHeaders: false,
    validate: { trustProxy: false }, // Evita ERR_ERL_PERMISSIVE_TRUST_PROXY
});

// Rate limiter para autenticação (mais restritivo)
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 5, // 5 tentativas de login
    message: 'Muitas tentativas de login, tente novamente em 15 minutos.',
    skipSuccessfulRequests: true,
    validate: { trustProxy: false }, // Evita ERR_ERL_PERMISSIVE_TRUST_PROXY
});

// Rate limiter para uploads (muito restritivo)
const uploadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hora
    max: 10, // 10 uploads por hora
    message: 'Limite de uploads atingido, tente novamente em 1 hora.',
    validate: { trustProxy: false }, // Evita ERR_ERL_PERMISSIVE_TRUST_PROXY
});

console.log('✅ Rate limiting configurado');
// ========================================

// --- Rotas ---

// Rota de Layout (Stories)
app.get('/layout', isAuthenticated, (req, res) => {
    const userContext = getUserContext(req.session);
    res.render('layout', { user: userContext, path: '/layout' });
});

// Rota de Notificação Extrajudicial
app.get('/notificacao', isAuthenticated, (req, res) => {
    const userContext = getUserContext(req.session);
    res.render('notificacao', { user: userContext, path: '/notificacao' });
});

// --- Rota de Análise de Documentos (IA) ---
// Configuração específica de Multer para memória (não salvar em disco)
const memoryUpload = multer({ storage: multer.memoryStorage() });

app.get('/analise-documentos', isAuthenticated, (req, res) => {
    const userContext = getUserContext(req.session);
    res.render('analise-documentos', { user: userContext, path: '/analise-documentos' });
});

app.post('/api/analise-documentos/process', isAuthenticated, memoryUpload.fields([{ name: 'edital', maxCount: 1 }, { name: 'matricula', maxCount: 1 }]), async (req, res) => {
    try {
        if (!req.files || !req.files['edital'] || !req.files['matricula']) {
            return res.status(400).json({ error: 'É necessário enviar o Edital e a Matrícula.' });
        }

        const webhookUrl = process.env.N8N_DOCUMENT_ANALYSIS_WEBHOOK;

        // Mock Response se WEBHOOK não estiver configurado
        if (!webhookUrl) {
            console.log('⚠️ N8N_DOCUMENT_ANALYSIS_WEBHOOK não configurado. Retornando mock.');
            // Simular delay
            await new Promise(resolve => setTimeout(resolve, 2000));
            return res.json({
                analysis: `# Análise Jurídica Preliminar (Simulação)\n\n**Atenção:** O webhook do n8n não está configurado. Adicione \`N8N_DOCUMENT_ANALYSIS_WEBHOOK\` ao seu arquivo .env.\n\n## 1. Análise do Edital\n- **Leiloeiro:** Leilão Exemplo S/A\n- **Data Prevista:** 15/02/2026\n- **Condições:** Pagamento à vista com 10% de desconto ou financiado em até 60x.\n\n## 2. Análise da Matrícula\n- **Proprietário:** João da Silva (Executado)\n- **Ônus Identificados:**\n  - R-3: Hipoteca em favor do Banco X (Objeto da execução).\n  - AV-4: Penhora trabalhista (Risco Médio - Necessário verificar se o valor da arrematação cobre).\n\n## 3. Conclusão\nDocumentação viável para arrematação, porém recomenda-se solicitar planilha de débitos atualizada do processo trabalhista antes do lance.`
            });
        }

        // SOLUÇÃO FINAL: Processamento Direto via Gemini (Server-Side)
        // Isso elimina o erro de timeout/upload do n8n para arquivos grandes/imagens.

        const { GoogleGenerativeAI } = await import('@google/generative-ai');

        // Verifica se tem chave API
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            throw new Error('GEMINI_API_KEY não configurada no .env');
        }

        const genAI = new GoogleGenerativeAI(apiKey);
        // "gemini-flash-latest" aponta para a versão estável com melhor cota gratuita
        const modelName = "gemini-flash-latest";
        const model = genAI.getGenerativeModel({ model: modelName });

        // Converter buffers para formato do Google
        const fileToPart = (buffer, mimeType) => {
            return {
                inlineData: {
                    data: buffer.toString("base64"),
                    mimeType
                }
            };
        };

        const editalPart = fileToPart(req.files['edital'][0].buffer, "application/pdf");
        const matriculaPart = fileToPart(req.files['matricula'][0].buffer, "application/pdf");

        const prompt = `
        ATUE COMO UM EXPERT JURÍDICO EM LEILÕES DE IMÓVEIS (ADVOGADO SÊNIOR).
        Sua missão é realizar uma "Due Diligence" completa e rigorosa nos documentos anexos (Edital e Matrícula).
        O objetivo é fornecer segurança total para um investidor arrematar o imóvel.

        ⚠️DIRETRIZES TÉCNICAS:
        - Os arquivos podem conter imagens escaneadas: USE OCR AVANÇADO.
        - Seja EXTREMAMENTE PRECISO com valores, datas e números de processos.
        - Se uma informação não estiver nos documentos, diga explicitamente: "NÃO CONSTA NOS DOCUMENTOS ANALISADOS".

        GERE UM RELATÓRIO TÉCNICO ESTRUTURADO EM MARKDOWN SEGUINDO ESTE MODELO RIGOROSAMENTE:

        ## 1. VEREDITO EXECUTIVO (Resumo Rápido)
        **Classificação de Risco:** (🟢 BAIXO / 🟡 MÉDIO / 🔴 ALTO)
        **Parecer Final:** (Recomendado / Recomendado com Ressalvas / Não Recomendado)
        > *Resumo em 2 linhas justificando a classificação.*

        ## 2. DADOS DO IMÓVEL E LEILÃO
        - **Imóvel:** [Endereço Completo conforme Matrícula]
        - **Matrícula:** [Número] | **Cartório:** [Nome do Cartório]
        - **Leilão/Leiloeiro:** [Nome]
        - **Datas do Leilão:** 1ª Praça: [Data/Valor] | 2ª Praça: [Data/Valor]
        - **Condições de Pagamento:** [Detalhar se aceita financiamento, parcelamento ou desconto à vista]

        ## 3. ANÁLISE DA MATRÍCULA (O Cação Jurídico)
        *Liste cronologicamente os ônus ativos.*
        - **Proprietário Atual:** [Nome]
        - **Ônus R.X / Av.X:** [Descreva a penhora/hipoteca/arresto] -> *Análise: É baixado com o leilão?*
        - **Alerta de Riscos Específicos:** (Usufruto, Doação, Cláusulas de Inalienabilidade, Locação averbada?)

        ## 4. ANÁLISE DO EDITAL (Regras do Jogo)
        - **Responsabilidade por Débitos de Condomínio:** [Quem paga? O arrematante ou o valor da venda?]
        - **Responsabilidade por IPTU:** [Sub-roga no preço (Art. 130 CTN) ou arrematante paga?]
        - **Situação da Ocupação:** [Ocupado ou Desocupado? Quem paga desocupação?]
        - **Comissão do Leiloeiro:** [Percentual]

        ## 5. RECOMENDAÇÕES ESTRATÉGICAS AO ASSESSOR
        *O que o assessor deve fazer antes de dar o lance?*
        1. [Ex: Levantar débitos de condomínio atualizados junto à administradora]
        2. [Ex: Verificar existência de recursos pendentes no processo X]
        3. [Ex: Visitar o local para confirmar ocupação]

        ---
        **AVISO LEGAL:** Esta análise é baseada exclusivamente nos documentos fornecidos e serve como triagem preliminar.
        `;

        console.log(`Enviando para Gemini (${modelName})...`);

        let responseText;
        try {
            const result = await model.generateContent([prompt, editalPart, matriculaPart]);
            const response = await result.response;
            responseText = response.text();
        } catch (error) {
            if (error.message.includes('429')) {
                console.warn('⚠️ Cota excedida (429). Aguardando 15s para tentar novamente...');
                await new Promise(resolve => setTimeout(resolve, 15000));

                // Segunda tentativa
                const resultRetry = await model.generateContent([prompt, editalPart, matriculaPart]);
                const responseRetry = await resultRetry.response;
                responseText = responseRetry.text();
            } else {
                throw error;
            }
        }

        res.json({ analysis: responseText });

    } catch (error) {
        console.error('Erro ao processar análise:', error);
        res.status(500).json({ error: error.message || 'Falha ao processar documentos.' });
    }
});

// Rota de Autenticação Modularizada
app.use('/', (await import('./routes/auth.js')).default);


// Middleware de Verificação de Admin Estrita (Bypass Ativado)
const requireAdmin = (req, res, next) => {
    return next();
};

// Rota para listar convites (admin)
app.get('/admin/invites', requireAdmin, async (req, res) => {
    try {
        const invites = await db.all('SELECT * FROM invites ORDER BY created_at DESC');

        // Dados do usuário da sessão
        const username = req.session.username || 'Admin';
        const email = req.session.email || '';
        const profile_pic_url = req.session.profile_pic_url || null;

        res.render('admin_invites', {
            invites,
            user: { ...getUserContext(req.session) }, // Use helper to ensure consistency
            username,
            email,
            profile_pic_url,
            supabaseUrl: '',
            supabaseAnonKey: '',
            baseUrl: `${req.protocol}://${req.get('host')}`,
            message: req.query.message || null,
            previewUrl: req.query.previewUrl || null
        });
    } catch (err) {
        console.error('Erro ao buscar convites:', err);
        res.status(500).send('Erro ao buscar convites');
    }
});

// Rota de Diagnóstico de Versão
app.get('/version', (req, res) => {
    res.json({ version: '1.0.2', timestamp: new Date().toISOString() });
});

// Rota para criar convites (admin)
app.post('/admin/invites', requireAdmin, async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).send('E-mail é obrigatório');

        // Basic email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.redirect('/admin/invites?message=' + encodeURIComponent('Erro: Formato de e-mail inválido.'));
        }

        // Check if user already exists with this email
        const existingUser = await db.get('SELECT id FROM users WHERE email = ?', [email]);
        if (existingUser) {
            return res.redirect('/admin/invites?message=' + encodeURIComponent('Erro: Já existe um usuário com este e-mail.'));
        }

        const crypto = await import('crypto');
        const token = crypto.randomBytes(24).toString('hex');
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 dias

        await db.run('INSERT INTO invites (email, token, created_by, expires_at) VALUES (?, ?, ?, ?)', [email, token, req.session.userId, expiresAt.toISOString()]);

        const inviteUrl = `${req.protocol}://${req.get('host')}/invite/accept?token=${token}`;

        // Não enviamos mais e-mail, apenas geramos o link
        console.log(`✅ Convite gerado para ${email}: ${inviteUrl}`);

        let message = 'Convite gerado com sucesso!';
        let previewUrl = null;

        // Tenta enviar e-mail via SMTP ou Ethereal (para testes)
        try {
            let transporter;

            if (process.env.SMTP_HOST) {
                transporter = nodemailer.createTransport({
                    host: process.env.SMTP_HOST,
                    port: process.env.SMTP_PORT || 587,
                    secure: false,
                    auth: {
                        user: process.env.SMTP_USER,
                        pass: process.env.SMTP_PASS,
                    },
                });
            } else {
                console.log('⚠️ SMTP não configurado. Criando conta de teste no Ethereal...');
                const testAccount = await nodemailer.createTestAccount();
                transporter = nodemailer.createTransport({
                    host: testAccount.smtp.host,
                    port: testAccount.smtp.port,
                    secure: testAccount.smtp.secure,
                    auth: {
                        user: testAccount.user,
                        pass: testAccount.pass,
                    },
                });
            }

            const info = await transporter.sendMail({
                from: `"Arremata System" <${process.env.SMTP_USER || 'noreply@arremata.local'}>`,
                to: email,
                subject: "Seu Convite para o Arremata!",
                html: `
                    <div style="font-family: sans-serif; padding: 20px; color: #333; background: #f4f4f4;">
                        <div style="max-width: 600px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                            <h2 style="color: #007bff;">Bem-vindo ao Arremata!</h2>
                            <p>Você foi convidado para acessar o sistema de gestão.</p>
                            <div style="padding: 20px 0; text-align: center;">
                                <a href="${inviteUrl}" style="background: #007bff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
                                    Aceitar Convite e Criar Conta
                                </a>
                            </div>
                            <p style="color: #666; font-size: 14px;">Ou copie este link:</p>
                            <p style="background: #eee; padding: 10px; border-radius: 4px; word-break: break-all; font-family: monospace;">${inviteUrl}</p>
                            <p style="font-size: 12px; color: #999; margin-top: 20px;">Este link expira em 7 dias.</p>
                        </div>
                    </div>
                `
            });

            console.log(`📧 E-mail de convite enviado para ${email}`);

            if (!process.env.SMTP_HOST) {
                previewUrl = nodemailer.getTestMessageUrl(info);
                console.log('🔗 Preview URL (Ethereal):', previewUrl);
                message = 'Convite gerado (Modo Simulação: SMTP Desligado)';
            } else {
                message = 'Convite gerado e e-mail enviado!';
            }

        } catch (emailErr) {
            console.error('❌ Falha ao enviar e-mail (mas convite foi criado):', emailErr);
            message = 'Convite criado, mas erro ao enviar email.';
        }

        res.redirect(`/admin/invites?message=${encodeURIComponent(message)}${previewUrl ? '&previewUrl=' + encodeURIComponent(previewUrl) : ''}`);
        return; // Ensure no fall-through
    } catch (err) {
        console.error('Erro ao criar convite:', err);
        res.status(500).send('Erro ao criar convite');
    }
});

// Página pública para aceitar convite (lead)
app.get('/invite/accept', async (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).send('Token inválido (vazio)');

    // Garantir que não há espaços extras
    const cleanToken = token.trim();

    console.log(`🔍 Tentativa de acesso com token: "${cleanToken}"`);

    try {
        const invite = await db.get('SELECT * FROM invites WHERE token = ?', [cleanToken]);

        if (!invite) {
            console.error(`❌ Token não encontrado: "${cleanToken}"`);

            return res.status(404).send(`
                <!DOCTYPE html>
                <html lang="pt-BR">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Link Inválido | Arremata!</title>
                    <script src="https://cdn.tailwindcss.com"></script>
                </head>
                <body class="bg-gray-100 h-screen flex items-center justify-center">
                    <div class="bg-white p-8 rounded-xl shadow-lg max-w-md w-full text-center">
                        <div class="w-16 h-16 bg-red-100 text-red-500 rounded-full flex items-center justify-center mx-auto mb-4">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-8 h-8">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                            </svg>
                        </div>
                        <h1 class="text-2xl font-bold text-gray-800 mb-2">Link Inválido ou Expirado</h1>
                        <p class="text-gray-600 mb-6">Não encontramos este convite. Ele pode ter sido cancelado, expirado ou o link está incorreto.</p>
                        <p class="text-sm text-gray-500 mb-6 bg-gray-50 p-3 rounded border border-gray-200">
                            Dica: Peça ao administrador para gerar um novo link atualizado na tabela de convites.
                        </p>
                        <a href="/login" class="inline-block bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 transition-colors font-medium">Voltar ao Login</a>
                    </div>
                </body>
                </html>
            `);
        }

        if (invite.used) {
            console.warn(`⚠️ Token já utilizado: "${cleanToken}" por ${invite.email}`);
            return res.status(400).send('Este convite já foi utilizado.');
        }

        if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
            console.warn(`⚠️ Token expirado: "${cleanToken}"`);
            return res.status(400).send('Este convite expirou (validade de 7 dias).');
        }

        console.log(`✅ Convite válido encontrado para: ${invite.email}`);

        // renderiza página pedindo username e senha
        res.render('invite_accept', { token: token, email: invite.email, error: null });
    } catch (err) {
        console.error('Erro em invite/accept:', err);
        res.status(500).send('Erro interno');
    }
});

// Processa criação de conta a partir do convite (Local Auth)
app.post('/invite/accept', async (req, res) => {
    const { token, username, password } = req.body;
    if (!token || !username || !password) return res.status(400).send('Dados incompletos');

    try {
        const invite = await db.get('SELECT * FROM invites WHERE token = ?', [token]);
        if (!invite) return res.status(400).send('Convite inválido');
        if (invite.used) return res.status(400).send('Convite já utilizado');
        if (invite.expires_at && new Date(invite.expires_at) < new Date()) return res.status(400).send('Convite expirado');

        // Check if email already exists
        const existing = await db.get('SELECT id FROM users WHERE email = ?', [invite.email]);
        if (existing) {
            return res.status(400).send('Este e-mail já está cadastrado.');
        }

        // Hash password
        const hashedPassword = await hashPassword(password);

        // Marca invite como usado
        await db.run('UPDATE invites SET used = 1 WHERE id = ?', [invite.id]);

        // Cria usuário local
        const result = await db.run(
            'INSERT INTO users (username, password, profile_pic_url, email, is_admin) VALUES (?, ?, ?, ?, 0)',
            [username, hashedPassword, null, invite.email]
        );
        const newId = result.lastID || result.stmt?.lastID;

        // Cria sessão
        req.session.userId = newId;
        req.session.username = username;
        req.session.email = invite.email;
        req.session.profile_pic_url = null;
        req.session.isAdmin = false;

        res.redirect('/perfil?success=registered');
    } catch (err) {
        console.error('Erro em POST /invite/accept:', err);
        return res.status(500).send('Erro interno ao criar conta.');
    }
});

// -----------------------
// Rotas do Chat / Integração com n8n - REMOVIDAS
// -----------------------

// Rota /session removida (Auth Local)

// Rota principal da aplicação (protegida)
app.get('/', isAuthenticated, async (req, res) => {
    const baseContext = {
        username: req.session.username || 'Usuário',
        email: req.session.email || 'Sem email',
        profile_pic_url: req.session.profile_pic_url || null,
        user: {
            username: req.session.username || 'Usuário',
            email: req.session.email || 'Sem email',
            profile_pic_url: req.session.profile_pic_url || null,
            isAdmin: req.session.isAdmin || false
        }
    };

    try {
        console.log('🔍 Dashboard: Iniciando carregamento para userId:', req.session.userId);

        if (!req.session.userId) {
            console.warn('⚠️ UserId não encontrado na sessão');
            return res.render('index', {
                ...baseContext,
                stats: null,
                recentProperties: [],
                growth: null
            });
        }

        // ADVISOR DASHBOARD LOGIC
        // 1. Fetch all clients managed by this advisor
        const clients = await db.all('SELECT id, status FROM clientes WHERE assessor_id = ?', [req.session.userId]);
        const clientIds = clients.map(c => c.id);
        const activeClients = clients.filter(c => c.status === 'ativo').length;

        let totalProperties = 0;
        let vgvManagement = 0;
        let recentProperties = [];
        let growthData = null;

        if (clientIds.length > 0) {
            // 2. Fetch all properties linked to these clients
            const placeholders = clientIds.map(() => '?').join(',');
            const properties = await db.all(
                `SELECT * FROM carteira_imoveis WHERE cliente_id IN (${placeholders}) ORDER BY data_aquisicao DESC`,
                clientIds
            );

            totalProperties = properties.length;
            vgvManagement = properties.reduce((sum, p) => sum + (p.valor_venda_estimado || 0), 0);

            // Get recent 5
            recentProperties = properties.slice(0, 5);

            // 3. Calculate Monthly Growth Data (Last 6 Months)
            const months = {};
            const today = new Date();
            for (let i = 5; i >= 0; i--) {
                const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
                const key = d.toISOString().slice(0, 7); // YYYY-MM
                months[key] = {
                    label: d.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '').toUpperCase(),
                    profit: 0,
                    volume: 0
                };
            }

            properties.forEach(imovel => {
                if (imovel.data_aquisicao) {
                    try {
                        const dateVal = new Date(imovel.data_aquisicao);
                        if (!isNaN(dateVal.getTime())) {
                            const dateKey = dateVal.toISOString().slice(0, 7);
                            if (months[dateKey]) {
                                months[dateKey].profit += parseFloat(imovel.lucro_estimado || 0);
                                months[dateKey].volume += 1;
                            }
                        }
                    } catch (e) {
                        // Ignore invalid dates
                    }
                }
            });

            growthData = {
                labels: Object.values(months).map(m => m.label),
                profitData: Object.values(months).map(m => m.profit),
                volumeData: Object.values(months).map(m => m.volume)
            };
        }



        // --- Blacklist Logic Implementation ---

        // 1. Fetch all 'new' leads explicitly to analyze their quality
        const incomingLeads = await db.all("SELECT * FROM leads WHERE status = 'novo'");

        // 2. Fetch all historic phone numbers (leads that are NOT 'novo') to define 'already known'
        const existingPhonesQuery = await db.all("SELECT whatsapp FROM leads WHERE status != 'novo' AND whatsapp IS NOT NULL");

        // Helper to normalize phone (digits only)
        const normalizePhone = (p) => p ? String(p).replace(/\D/g, '') : '';
        const knownPhones = new Set(existingPhonesQuery.map(l => normalizePhone(l.whatsapp)));

        let validLeadsCount = 0;
        let blacklistCount = 0;
        let blacklistValue = 0;
        const seenInBatch = new Set();

        incomingLeads.forEach(lead => {
            const rawPhone = lead.whatsapp;
            const phone = normalizePhone(rawPhone);

            // Determine potential value (Capital Entrada or Vista, whichever is higher)
            const potentialValue = Math.max(parseFloat(lead.capital_entrada || 0), parseFloat(lead.capital_vista || 0));

            let isDuplicate = false;

            if (phone && phone.length > 5) { // Basic validity check
                // Check if phone exists in history
                if (knownPhones.has(phone)) isDuplicate = true;

                // Check if duplicate within the current 'new' batch (keep first encountered)
                if (seenInBatch.has(phone)) isDuplicate = true;

                seenInBatch.add(phone);
            }

            if (isDuplicate) {
                blacklistCount++;
                blacklistValue += potentialValue;
            } else {
                validLeadsCount++;
            }
        });

        const advisorStats = {
            vgv_gestao: vgvManagement,

            clientes_ativos: activeClients,
            total_imoveis: totalProperties,
            leads_waiting: validLeadsCount, // Only valid ones shown in main counter
            blacklist_count: blacklistCount,
            blacklist_value: blacklistValue
        };
        console.log('📊 Stats do Assessor:', JSON.stringify(advisorStats, null, 2));
        console.log('✅ Dashboard: Dados carregados com sucesso');

        res.render('index', {
            ...baseContext,
            stats: advisorStats,
            growth: growthData,
            recentProperties: recentProperties,
            commissionDetails: []
        });
    } catch (error) {
        console.error('❌ ERRO CRÍTICO NO DASHBOARD:', error.message);
        console.error('Stack trace:', error.stack);
        res.status(500).render('debug_error', { error });
    }
});


// Rota para a página de perfil
app.get('/perfil', isAuthenticated, async (req, res) => {
    try {
        const user = await db.get('SELECT id, username, profile_pic_url FROM users WHERE id = ?', [req.session.userId]);
        res.render('perfil', { user: user, success: req.query.success, error: req.query.error });
    } catch (error) {
        console.error('Erro ao carregar perfil:', error);
        res.status(500).send("Erro ao carregar a página de perfil.");
    }
});

// Rota para atualizar a foto do perfil
app.post('/perfil/update-photo', uploadLimiter, isAuthenticated, upload.single('profilePhoto'), async (req, res) => {
    // Adiciona uma verificação para o caso de nenhum arquivo ser enviado
    if (!req.file) {
        return res.status(400).redirect('/perfil?error=photo');
    }

    const profilePhotoUrl = `/uploads/${req.file.filename}`;
    await db.run('UPDATE users SET profile_pic_url = ? WHERE id = ?', [profilePhotoUrl, req.session.userId]);
    req.session.profile_pic_url = profilePhotoUrl; // Atualiza a foto na sessão
    res.redirect('/perfil?success=photo');
});

// Rota para atualizar informações do perfil (nome)
app.post('/perfil/update-info', isAuthenticated, async (req, res) => {
    try {
        const { username } = req.body;
        await db.run('UPDATE users SET username = ? WHERE id = ?', [username, req.session.userId]);
        req.session.username = username; // Atualiza o nome na sessão
        res.redirect('/perfil?success=info');
    } catch (error) {
        console.error('Erro ao atualizar informações do perfil:', error);
        res.redirect('/perfil?error=server');
    }
});

// Rota para alterar senha (Local)
app.post('/perfil/change-password', isAuthenticated, async (req, res) => {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
        return res.redirect('/perfil?error=new_password_length');
    }

    try {
        const hashedPassword = await hashPassword(newPassword);
        await db.run('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, req.session.userId]);
        res.redirect('/perfil?success=password_changed');
    } catch (error) {
        console.error('Erro ao alterar senha:', error);
        res.redirect('/perfil?error=server');
    }
});

// Note: password management is handled by Supabase. To change password, use Supabase account management flows.

// Rota para zerar todos os dados do usuário
app.post('/perfil/reset-all-data', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.userId;

        // Deleta todos os dados do usuário
        await db.run('DELETE FROM saved_calculations WHERE user_id = ?', [userId]);
        await db.run('DELETE FROM arremates WHERE user_id = ?', [userId]);
        await db.run('DELETE FROM carteira_custos WHERE user_id = ?', [userId]);
        await db.run('DELETE FROM carteira_imoveis WHERE user_id = ?', [userId]);

        console.log(`✅ Todos os dados do usuário ${userId} foram zerados.`);

        res.json({ success: true });
    } catch (error) {
        console.error('Erro ao zerar dados:', error);
        res.status(500).json({ success: false, error: 'Erro ao zerar dados' });
    }
});

// Rota para o Histórico de Arremates
app.get('/historico', isAuthenticated, async (req, res) => {
    try {
        // Fetch from carteira_imoveis (Unified Wallet)
        // Filter by user_id. We can decide if we want to show client properties here too, 
        // but for "Meus Arremates" it usually implies own properties or ALL managed properties.
        // Let's get ALL properties managed by this user (user_id = session)

        const arremates = await db.all(`
            SELECT * FROM carteira_imoveis 
            WHERE user_id = ? 
            ORDER BY data_aquisicao DESC
        `, [req.session.userId]);

        // Formata o valor do arremate para o padrão de moeda brasileiro (BRL)
        const arrematesFormatados = arremates.map(item => {
            return {
                ...item,
                // Map carteira fields to legacy arremate fields if needed by view
                descricao_imovel: item.descricao, // map descricao -> descricao_imovel
                data_arremate: item.data_aquisicao, // map data_aquisicao -> data_arremate
                valor_formatado: (item.valor_compra || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
                status: item.status || 'Arrematado'
            };
        });

        res.render('historico', {
            arremates: arrematesFormatados,
            user: getUserContext(req.session),
            username: req.session.username,
            email: req.session.email || 'Acesso de Lead',
            profile_pic_url: req.session.profile_pic_url
        });
    } catch (error) {
        console.error('Erro ao buscar histórico:', error);
        res.status(500).send("Erro ao carregar o histórico.");
    }
});

// Rota para adicionar um novo arremate
app.get('/historico/add', isAuthenticated, (req, res) => {
    // Pega os dados da calculadora da sessão, se existirem
    const calcData = req.session.calcData || {};
    delete req.session.calcData; // Limpa os dados da sessão após o uso

    res.render('adicionar-arremate', {
        user: {
            username: req.session.username,
            profile_pic_url: req.session.profile_pic_url
        },
        calcData: calcData,
        errors: []
    });
});

app.post('/historico/add', isAuthenticated, [
    // Validações básicas
    body('descricao_imovel').notEmpty().withMessage('A descrição do imóvel é obrigatória.'),
    body('data_arremate').isDate().withMessage('A data do arremate é inválida.'),
    body('valor_arremate').isFloat({ gt: 0 }).withMessage('O valor do arremate deve ser um número positivo.')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        // Se houver erros, renderiza o formulário novamente com os erros e os dados inseridos
        return res.status(400).render('adicionar-arremate', {
            user: { username: req.session.username, profile_pic_url: req.session.profile_pic_url },
            calcData: req.body, // Retorna os dados que o usuário já preencheu
            errors: errors.array()
        });
    }

    try {
        const {
            descricao_imovel,
            endereco,
            data_arremate,
            valor_arremate,
            leiloeiro,
            edital,
            calc_valor_venda,
            calc_custo_reforma,
            calc_custo_itbi,

            condominioMensal,
            iptuMensal,
            cliente_id, // Novo: suporte para vincular ao cliente
            ...calcFields
        } = req.body;

        console.log('📝 POST /historico/add - Payload:', {
            condominioMensal,
            iptuMensal,
            calc_valor_venda,
            cliente_id,
            calcFields_keys: Object.keys(calcFields)
        });

        // Helper para extrair números de strings formatadas (pt-BR) ou números puros
        const parseMonetary = (val) => {
            if (val === null || val === undefined || val === '') return 0;
            if (typeof val === 'number') return val;

            const strVal = val.toString().trim();

            // Se tiver vírgula, assume formato BRL (Ex: "1.000,00" ou "10,50")
            if (strVal.includes(',')) {
                // Remove pontos de milhar, mantém vírgula e sinal de menos e dígitos
                const clean = strVal.replace(/[^\d,-]/g, '');
                // Troca vírgula por ponto para converter
                return parseFloat(clean.replace(',', '.')) || 0;
            }

            // Se NÃO tiver vírgula, assume formato Standard/US (Ex: "1000.00" vindo de inputs hidden, ou "1000")
            // Apenas remove caracteres inválidos, mantendo o ponto
            const clean = strVal.replace(/[^\d.-]/g, '');
            return parseFloat(clean) || 0;
        };

        // 1. Salva no histórico de arremates
        const arremateResult = await db.run(
            `INSERT INTO arremates (
                user_id, descricao_imovel, endereco, data_arremate, valor_arremate, leiloeiro, edital,
                calc_valor_avaliacao, calc_custo_itbi, calc_custo_registro, calc_custo_leiloeiro,
                calc_custo_reforma, calc_outros_custos, calc_valor_venda, calc_custo_corretagem,
                calc_imposto_ganho_capital, calc_lucro_liquido, calc_roi_liquido
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                req.session.userId, descricao_imovel, endereco, data_arremate,
                parseMonetary(valor_arremate), leiloeiro, edital,
                parseMonetary(calcFields.calc_valor_avaliacao), parseMonetary(calc_custo_itbi),
                parseMonetary(calcFields.calc_custo_registro), parseMonetary(calcFields.calc_custo_leiloeiro),
                parseMonetary(calc_custo_reforma), parseMonetary(calcFields.calc_outros_custos),
                parseMonetary(calc_valor_venda), parseMonetary(calcFields.calc_custo_corretagem),
                parseMonetary(calcFields.calc_imposto_ganho_capital), parseMonetary(calcFields.calc_lucro_liquido),
                parseMonetary(calcFields.calc_roi_liquido)
            ]
        );

        // 2. Automaticamente adiciona à carteira (com cliente_id se fornecido)
        const carteiraResult = await db.run(
            'INSERT INTO carteira_imoveis (user_id, cliente_id, descricao, endereco, valor_compra, data_aquisicao, valor_venda_estimado, status, condominio_estimado, iptu_estimado, lucro_estimado, roi_estimado) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
                req.session.userId,
                cliente_id ? parseInt(cliente_id) : null, // Vincula ao cliente se fornecido
                descricao_imovel,
                endereco || 'Endereço a definir',
                parseMonetary(valor_arremate) || 0,
                data_arremate,
                parseMonetary(calc_valor_venda) || 0,
                'Arrematado',
                parseMonetary(condominioMensal) || 0,
                parseMonetary(iptuMensal) || 0,
                parseMonetary(calcFields.calc_lucro_liquido) || 0,
                parseMonetary(calcFields.calc_roi_liquido) || 0
            ]
        );

        const imovelId = carteiraResult.lastID;





        // 3. Adiciona custos estimados na carteira (se existirem no cálculo)
        if (calc_custo_reforma && parseFloat(calc_custo_reforma) > 0) {
            await db.run(
                'INSERT INTO carteira_custos (user_id, imovel_id, tipo_custo, valor, data_custo, descricao) VALUES (?, ?, ?, ?, ?, ?)',
                [req.session.userId, imovelId, 'Reforma', parseFloat(calc_custo_reforma), data_arremate, 'Estimativa de reforma (do cálculo)']
            );
        }

        if (calc_custo_itbi && parseFloat(calc_custo_itbi) > 0) {
            await db.run(
                'INSERT INTO carteira_custos (user_id, imovel_id, tipo_custo, valor, data_custo, descricao) VALUES (?, ?, ?, ?, ?, ?)',
                [req.session.userId, imovelId, 'Impostos', parseFloat(calc_custo_itbi), data_arremate, 'ITBI (do cálculo)']
            );
        }

        if (calcFields.calc_custo_registro && parseFloat(calcFields.calc_custo_registro) > 0) {
            await db.run(
                'INSERT INTO carteira_custos (user_id, imovel_id, tipo_custo, valor, data_custo, descricao) VALUES (?, ?, ?, ?, ?, ?)',
                [req.session.userId, imovelId, 'Documentação', parseFloat(calcFields.calc_custo_registro), data_arremate, 'Custos de registro (do cálculo)']
            );
        }

        if (calcFields.calc_custo_leiloeiro && parseFloat(calcFields.calc_custo_leiloeiro) > 0) {
            await db.run(
                'INSERT INTO carteira_custos (user_id, imovel_id, tipo_custo, valor, data_custo, descricao) VALUES (?, ?, ?, ?, ?, ?)',
                [req.session.userId, imovelId, 'Comissão', parseFloat(calcFields.calc_custo_leiloeiro), data_arremate, 'Comissão Leiloeiro (do cálculo)']
            );
        }

        if (calcFields.calc_outros_custos && parseFloat(calcFields.calc_outros_custos) > 0) {
            await db.run(
                'INSERT INTO carteira_custos (user_id, imovel_id, tipo_custo, valor, data_custo, descricao) VALUES (?, ?, ?, ?, ?, ?)',
                [req.session.userId, imovelId, 'Outros', parseFloat(calcFields.calc_outros_custos), data_arremate, 'Outros custos iniciais (do cálculo)']
            );
        }

        if (calcFields.calc_custo_assessoria && parseFloat(calcFields.calc_custo_assessoria) > 0) {
            await db.run(
                'INSERT INTO carteira_custos (user_id, imovel_id, tipo_custo, valor, data_custo, descricao) VALUES (?, ?, ?, ?, ?, ?)',
                [req.session.userId, imovelId, 'Comissão', parseFloat(calcFields.calc_custo_assessoria), data_arremate, 'Assessoria (do cálculo)']
            );
        }

        if (calcFields.calc_debitos_pendentes && parseFloat(calcFields.calc_debitos_pendentes) > 0) {
            await db.run(
                'INSERT INTO carteira_custos (user_id, imovel_id, tipo_custo, valor, data_custo, descricao) VALUES (?, ?, ?, ?, ?, ?)',
                [req.session.userId, imovelId, 'Outros', parseFloat(calcFields.calc_debitos_pendentes), data_arremate, 'Débitos Pendentes (do cálculo)']
            );
        }

        if (calcFields.calc_custo_desocupacao && parseFloat(calcFields.calc_custo_desocupacao) > 0) {
            await db.run(
                'INSERT INTO carteira_custos (user_id, imovel_id, tipo_custo, valor, data_custo, descricao) VALUES (?, ?, ?, ?, ?, ?)',
                [req.session.userId, imovelId, 'Outros', parseFloat(calcFields.calc_custo_desocupacao), data_arremate, 'Desocupação / Advogado (do cálculo)']
            );
        }

        if (calcFields.calc_custo_seguro && parseFloat(calcFields.calc_custo_seguro) > 0) {
            await db.run(
                'INSERT INTO carteira_custos (user_id, imovel_id, tipo_custo, valor, data_custo, descricao) VALUES (?, ?, ?, ?, ?, ?)',
                [req.session.userId, imovelId, 'Seguro', parseFloat(calcFields.calc_custo_seguro), data_arremate, 'Seguro Fixo (do cálculo)']
            );
        }

        // Adiciona custos mensais recorrentes (Condomínio e IPTU)
        // BUGFIX: Usar a variável extraída 'condominioMensal' e não 'calcFields.condominioMensal' (que é undefined)
        if (condominioMensal && parseFloat(condominioMensal) > 0) {
            await db.run(
                'INSERT INTO carteira_custos (user_id, imovel_id, tipo_custo, valor, data_custo, descricao) VALUES (?, ?, ?, ?, ?, ?)',
                [req.session.userId, imovelId, 'Condomínio', parseFloat(condominioMensal), data_arremate, 'Condomínio (Estimativa Mensal)']
            );
            console.log(`✅ Custo de Condomínio salvo: R$ ${condominioMensal}`);
        }

        let iptuMensalCalc = 0;
        if (iptuMensal && parseFloat(iptuMensal) > 0) {
            iptuMensalCalc = parseFloat(iptuMensal); // Usar variável extraída
        } else if (calcFields.iptuAnual && parseFloat(calcFields.iptuAnual) > 0) {
            iptuMensalCalc = parseFloat(calcFields.iptuAnual) / 12;
        }

        if (iptuMensalCalc > 0) {
            await db.run(
                'INSERT INTO carteira_custos (user_id, imovel_id, tipo_custo, valor, data_custo, descricao) VALUES (?, ?, ?, ?, ?, ?)',
                [req.session.userId, imovelId, 'Impostos', iptuMensalCalc, data_arremate, 'IPTU (Estimativa Mensal)']
            );
            console.log(`✅ Custo de IPTU salvo: R$ ${iptuMensalCalc}/mês`);
        }

        console.log(`✅ Arremate salvo e adicionado à carteira automaticamente. Imóvel ID: ${imovelId}`);
        res.redirect('/historico');
    } catch (error) {
        console.error('Erro ao adicionar arremate:', error);
        res.status(500).send("Erro ao salvar o arremate.");
    }
});



// Rota para exibir o formulário de edição de um arremate
app.get('/historico/edit/:id', isAuthenticated, async (req, res) => {
    try {
        const arremate = await db.get('SELECT * FROM arremates WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId]);
        if (!arremate) {
            return res.status(404).send("Arremate não encontrado ou não pertence a você.");
        }
        // Passando o objeto 'user' completo para consistência
        const user = {
            username: req.session.username,
            profile_pic_url: req.session.profile_pic_url
        };
        res.render('editar-arremate', { arremate: arremate, user: user });
    } catch (error) {
        console.error('Erro ao carregar arremate para edição:', error);
        res.status(500).send("Erro ao carregar a página de edição.");
    }
});

// Rota para processar a edição de um arremate
app.post('/historico/edit/:id', isAuthenticated, async (req, res) => {
    const { descricao_imovel, endereco, data_arremate, valor_arremate, leiloeiro, edital } = req.body;
    try {
        await db.run(
            'UPDATE arremates SET descricao_imovel = ?, endereco = ?, data_arremate = ?, valor_arremate = ?, leiloeiro = ?, edital = ? WHERE id = ? AND user_id = ?',
            [descricao_imovel, endereco, data_arremate, valor_arremate, leiloeiro, edital, req.params.id, req.session.userId]
        );
        res.redirect('/historico');
    } catch (error) {
        console.error('Erro ao editar arremate:', error);
        res.status(500).send("Erro ao salvar as alterações.");
    }
});

// Rota para gerar o relatório
app.get('/historico/relatorio', isAuthenticated, async (req, res) => {
    try {
        const arremates = await db.all('SELECT *, printf("R$ %.2f", valor_arremate) as valor_formatado FROM arremates WHERE user_id = ? ORDER BY data_arremate ASC', [req.session.userId]);
        const user = await db.get('SELECT username FROM users WHERE id = ?', [req.session.userId]);
        res.render('relatorio', { arremates: arremates, user: user, dataGeracao: new Date().toLocaleDateString('pt-BR') });
    } catch (error) {
        console.error('Erro ao gerar relatório:', error);
        res.status(500).send("Erro ao gerar o relatório.");
    }
});

// Rota para a Calculadora de Viabilidade
app.get('/calculadora', isAuthenticated, async (req, res) => {
    try {
        const savedCalculations = await db.all('SELECT * FROM saved_calculations WHERE user_id = ? ORDER BY id DESC', [req.session.userId]);

        res.render('calculadora', {
            user: getUserContext(req.session),
            results: null, // Nenhum resultado no carregamento inicial
            inputData: {},
            savedCalculations: savedCalculations,
            success: req.query.success
        });
    } catch (error) {
        console.error('Erro ao carregar calculadora:', error);
        res.status(500).send("Erro ao carregar a página.");
    }
});

// API para buscar cálculos salvos (usado no modal de Meus Imóveis)
app.get('/api/saved-calculations', isAuthenticated, async (req, res) => {
    try {
        const savedCalculations = await db.all('SELECT * FROM saved_calculations WHERE user_id = ? ORDER BY id DESC', [req.session.userId]);
        res.json(savedCalculations);
    } catch (error) {
        console.error('Erro ao buscar cálculos salvos:', error);
        res.status(500).json({ error: 'Erro ao buscar cálculos.' });
    }
});

// Rota para atualizar cálculo salvo via API
app.put('/api/saved-calculations/:id', isAuthenticated, async (req, res) => {
    try {
        const calculoId = req.params.id;
        const { data } = req.body;

        // Verificar se o cálculo pertence ao usuário
        const calculo = await db.get(
            'SELECT * FROM saved_calculations WHERE id = ? AND user_id = ?',
            [calculoId, req.session.userId]
        );

        if (!calculo) {
            return res.status(404).json({ error: 'Cálculo não encontrado' });
        }

        // Atualizar apenas os dados, mantendo o nome
        await db.run(
            'UPDATE saved_calculations SET data = ? WHERE id = ? AND user_id = ?',
            [JSON.stringify(data), calculoId, req.session.userId]
        );

        res.json({ success: true, message: 'Cálculo atualizado com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar cálculo:', error);
        res.status(500).json({ error: 'Erro ao atualizar cálculo' });
    }
});

// Rota para excluir cálculo salvo via API
app.delete('/api/saved-calculations/:id', isAuthenticated, async (req, res) => {
    try {
        const calculoId = req.params.id;

        // Verificar e excluir
        // Note: db.run returns an object with 'changes' property indicating number of rows affected
        const result = await db.run(
            'DELETE FROM saved_calculations WHERE id = ? AND user_id = ?',
            [calculoId, req.session.userId]
        );

        if (result.changes === 0) {
            return res.status(404).json({ error: 'Cálculo não encontrado' });
        }

        res.json({ success: true, message: 'Cálculo excluído com sucesso' });
    } catch (error) {
        console.error('Erro ao excluir cálculo:', error);
        res.status(500).json({ error: 'Erro ao excluir cálculo' });
    }
});

// Importar cálculo salvo para a carteira
app.post('/api/portfolio/import-calculation/:id', isAuthenticated, async (req, res) => {
    try {
        const calc = await db.get('SELECT * FROM saved_calculations WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId]);
        if (!calc) return res.status(404).json({ error: 'Cálculo não encontrado' });

        const data = JSON.parse(calc.data);

        // Mapear dados do cálculo para a estrutura da carteira
        const descricao = calc.name;
        const valorCompra = data.valorArrematado || 0;
        const valorVendaEstimado = data.valorVendaFinal || 0;

        // Calcular lucro e ROI usando o ViabilityCalculator
        const calculator = new ViabilityCalculator();
        const results = calculator.calculateViability(data);

        // Usar a projeção de 4 meses como padrão para estimativas
        const lucroEstimado = results.projection4Months.resultadoLiquido || 0;
        const roiEstimado = results.projection4Months.roiLiquido || 0;

        // Inserir na carteira
        const result = await db.run(
            'INSERT INTO carteira_imoveis (user_id, descricao, endereco, valor_compra, data_aquisicao, valor_venda_estimado, status, condominio_estimado, iptu_estimado, lucro_estimado, roi_estimado) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
                req.session.userId,
                descricao,
                'Endereço a definir',
                valorCompra,
                new Date().toISOString().split('T')[0],
                valorVendaEstimado,
                'Arrematado',
                parseFloat(data.condominioMensal) || 0,
                (parseFloat(data.iptuAnual) / 12) || (parseFloat(data.iptuMensal) || 0),
                lucroEstimado,
                roiEstimado
            ]
        );

        const imovelId = result.lastID;

        // Opcional: Inserir custos estimados iniciais baseados no cálculo
        if (data.reforma) {
            await db.run('INSERT INTO carteira_custos (user_id, imovel_id, tipo_custo, valor, data_custo, descricao) VALUES (?, ?, ?, ?, ?, ?)',
                [req.session.userId, imovelId, 'Reforma', data.reforma, new Date().toISOString().split('T')[0], 'Estimativa Reforma']);
        }
        if (data.itbi) {
            const valorITBI = (valorCompra * (parseFloat(data.itbi) || 0)) / 100;
            await db.run('INSERT INTO carteira_custos (user_id, imovel_id, tipo_custo, valor, data_custo, descricao) VALUES (?, ?, ?, ?, ?, ?)',
                [req.session.userId, imovelId, 'Impostos', valorITBI, new Date().toISOString().split('T')[0], 'ITBI']);
        }

        res.json({ success: true, imovelId });
    } catch (error) {
        console.error('Erro ao importar cálculo:', error);
        res.status(500).json({ error: 'Erro ao importar cálculo' });
    }
});

// --- Rota da Vitrine de Oportunidades (Imóveis Estudados) ---

// 1. Página de Listagem
// 1. Página de Listagem
app.get('/oportunidades', isAuthenticated, async (req, res) => {
    try {
        console.log('--- Acessando /oportunidades ---');

        // Busca oportunidades COM o nome do assessor (JOIN), ignorando as removidas
        const oportunidades = await db.all(`
            SELECT oportunidades.*, users.username as autor, users.email as autor_email
            FROM oportunidades 
            LEFT JOIN users ON oportunidades.user_id = users.id 
            WHERE oportunidades.status != 'removido'
            ORDER BY oportunidades.created_at DESC
        `);

        console.log('Oportunidades encontradas:', oportunidades.length);

        if (typeof getUserContext !== 'function') {
            throw new Error('getUserContext não é uma função ou não está definida');
        }

        const context = {
            user: getUserContext(req.session),
            oportunidades: oportunidades
        };

        res.render('oportunidades', context, (err, html) => {
            if (err) {
                console.error('Erro de Renderização EJS:', err);
                return res.status(500).send('Erro de Renderização: ' + err.message);
            }
            res.send(html);
        });

    } catch (error) {
        console.error('Erro ao carregar oportunidades (catch block):', error);
        res.status(500).send("Erro ao carregar oportunidades: " + error.message);
    }
});

// 2. Criar Nova Oportunidade
app.post('/oportunidades', isAuthenticated, upload.any(), async (req, res) => {
    try {
        // Função helper para converter valores monetários
        const parseMonetary = (value) => {
            if (!value) return 0;
            if (typeof value === 'number') return value;
            // Remove R$, pontos (milhares) e substitui vírgula por ponto
            return parseFloat(String(value).replace(/[R$\s.]/g, '').replace(',', '.')) || 0;
        };

        const {
            titulo,
            descricao,
            observacoes,
            valor_arremate,
            valor_venda,
            lucro_estimado,
            roi_estimado,
            cidade,
            estado,
            tipo_imovel,
            link_caixa,
            foto_capa, // URL "manual" via hidden input, se não houver upload
            calculo_origem_id
        } = req.body;

        // --- Processamento de Arquivos ---
        let finalFotoCapa = foto_capa;
        let pdfPropostaPath = null;
        let pdfMatriculaPath = null;
        let pdfAnaliseJuridicaPath = null;

        // Com upload.any(), req.files é um array
        if (req.files && req.files.length > 0) {
            const fotoUpload = req.files.find(f => f.fieldname === 'foto_upload');
            const pdfProposta = req.files.find(f => f.fieldname === 'pdf_proposta');
            const pdfMatricula = req.files.find(f => f.fieldname === 'pdf_matricula');
            const pdfAnaliseJuridica = req.files.find(f => f.fieldname === 'pdf_analise_juridica');

            if (fotoUpload) {
                finalFotoCapa = '/uploads/' + fotoUpload.filename;
            }
            if (pdfProposta) {
                pdfPropostaPath = '/uploads/' + pdfProposta.filename;
            }
            if (pdfMatricula) {
                pdfMatriculaPath = '/uploads/' + pdfMatricula.filename;
            }
            if (pdfAnaliseJuridica) {
                pdfAnaliseJuridicaPath = '/uploads/' + pdfAnaliseJuridica.filename;
            }
        }

        // Parse dos valores numéricos
        const valorArremateNum = parseMonetary(valor_arremate);
        const valorVendaNum = parseMonetary(valor_venda);
        const lucroEstimadoNum = parseMonetary(lucro_estimado);
        const roiEstimadoNum = parseFloat(roi_estimado) || 0;

        await db.run(
            `INSERT INTO oportunidades(
            user_id, titulo, descricao, observacoes, valor_arremate, valor_venda, lucro_estimado,
            roi_estimado, cidade, estado, latitude, longitude, tipo_imovel, link_caixa, foto_capa, calculo_origem_id,
            pdf_proposta, pdf_matricula, pdf_analise_juridica
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                req.session.userId, titulo, descricao, observacoes, valorArremateNum, valorVendaNum, lucroEstimadoNum,
                roiEstimadoNum, cidade, estado, req.body.latitude || null, req.body.longitude || null,
                tipo_imovel, link_caixa, finalFotoCapa, calculo_origem_id,
                pdfPropostaPath, pdfMatriculaPath, pdfAnaliseJuridicaPath
            ]
        );

        res.json({ success: true, message: 'Oportunidade publicada com sucesso!' });
    } catch (error) {
        console.error('Erro ao criar oportunidade:', error);
        console.error('Body recebido:', req.body);
        console.error('Files recebidos:', req.files);
        res.status(500).json({ error: 'Erro ao publicar oportunidade: ' + error.message });
    }
});

app.post('/api/oportunidades/save-from-proposal', isAuthenticated, upload.none(), async (req, res) => {
    try {
        const {
            titulo, valorArremate, valorVenda, lucroEstimado, roiEstimado,
            cidade, estado, tipoImovel, linkCaixa, fotoCapa, pdfPropostaData
        } = req.body;

        // Converter valores monetários
        const parseMoney = (val) => {
            if (typeof val === 'number') return val;
            if (!val) return 0;
            return parseFloat(val.toString().replace('R$', '').replace(/\./g, '').replace(',', '.').trim());
        };

        const valorArremateNum = parseMoney(valorArremate);
        const valorVendaNum = parseMoney(valorVenda);
        const lucroEstimadoNum = parseMoney(lucroEstimado);

        // ROI já vem geralmente formatado, tentar limpar
        let roiEstimadoNum = roiEstimado;
        if (typeof roiEstimado === 'string') {
            roiEstimadoNum = parseFloat(roiEstimado.replace('%', '').replace(',', '.'));
        }

        // Salvar PDF se vier (opcional, pode ser implementado depois com upload de arquivo real)
        // Por enquanto, vamos focar nos dados estruturados.

        const result = await db.run(`
            INSERT INTO oportunidades(
            user_id, titulo, descricao, valor_arremate, valor_venda,
            lucro_estimado, roi_estimado, cidade, estado, tipo_imovel,
            link_caixa, foto_capa, status
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'disponivel')
        `, [
            req.session.userId,
            titulo || 'Oportunidade sem Título',
            `Imóvel estudado.ROI: ${roiEstimadoNum}% `,
            valorArremateNum,
            valorVendaNum,
            lucroEstimadoNum,
            roiEstimadoNum,
            cidade || '',
            estado || '',
            tipoImovel || 'Indefinido',
            linkCaixa || '',
            fotoCapa || '', // URL da imagem se disponível
        ]);

        res.json({ success: true, id: result.lastID, message: 'Oportunidade salva via proposta!' });

    } catch (error) {
        console.error('Erro ao salvar oportunidade via proposta:', error);
        res.status(500).json({ success: false, error: 'Erro ao salvar oportunidade.' });
    }
});

// Delete opportunity route (existing)
app.delete('/oportunidades/:id', isAuthenticated, async (req, res) => {
    try {
        const { id } = req.params;
        await db.run('DELETE FROM oportunidades WHERE id = ?', [id]);
        res.json({ success: true, message: 'Oportunidade removida com sucesso.' });
    } catch (error) {
        console.error('Erro ao remover oportunidade:', error);
        res.status(500).json({ error: 'Erro ao remover oportunidade.' });
    }
});

app.post('/calculadora', isAuthenticated, async (req, res) => {
    const calculator = new ViabilityCalculator();

    // --- CORREÇÃO ---
    // Cria uma cópia dos dados do formulário para o cálculo, convertendo para número.
    // Isso evita modificar o req.body original, que é usado para salvar a simulação.
    const inputData = { ...req.body };
    for (const key in inputData) {
        if (key !== 'tipoPagamento') {
            inputData[key] = parseFloat(inputData[key]) || 0;
        }
    }

    // Preserve boolean flags submitted by checkboxes (e.g., incluirLeiloeiro)
    inputData.incluirLeiloeiro = !!(req.body && (req.body.incluirLeiloeiro === '1' || req.body.incluirLeiloeiro === 'on' || req.body.incluirLeiloeiro === 'true'));

    // A alíquota vem como porcentagem (ex: 15), precisa ser convertida para decimal (ex: 0.15)
    if (inputData.aliquotaIRGC) {
        inputData.aliquotaIRGC = inputData.aliquotaIRGC / 100;
    }

    const results = calculator.calculateViability(inputData);

    // Busca cálculos salvos para exibir na página
    const savedCalculations = await db.all('SELECT * FROM saved_calculations WHERE user_id = ? ORDER BY id DESC', [req.session.userId]);

    res.render('calculadora', {
        user: {
            username: req.session.username,
            profile_pic_url: req.session.profile_pic_url,
        },
        results: results, // Passa os resultados para a view
        inputData: { ...req.body, ...inputData }, // Passa TODOS os dados, originais e calculados
        savedCalculations: savedCalculations,
        success: req.query.success,
        editMode: !!req.body.calculationId, // Preserva modo de edição se ID estiver presente
        editingId: req.body.calculationId,
        editingName: req.body.editingName
    });
});

// Rota para editar cálculo salvo
app.get('/calculadora/editar/:id', isAuthenticated, async (req, res) => {
    try {
        const calculoId = req.params.id;

        // Buscar o cálculo específico
        const calculo = await db.get(
            'SELECT * FROM saved_calculations WHERE id = ? AND user_id = ?',
            [calculoId, req.session.userId]
        );

        if (!calculo) {
            return res.status(404).send('Cálculo não encontrado');
        }

        // Parse dos dados salvos
        const inputData = JSON.parse(calculo.data);

        // Buscar todos os cálculos salvos para exibir na lista
        const savedCalculations = await db.all(
            'SELECT * FROM saved_calculations WHERE user_id = ? ORDER BY id DESC',
            [req.session.userId]
        );

        // Renderizar a calculadora com os dados pré-preenchidos
        res.render('calculadora', {
            user: {
                username: req.session.username,
                profile_pic_url: req.session.profile_pic_url
            },
            results: null, // Não calcular automaticamente, usuário pode modificar
            inputData: inputData, // Dados do cálculo para pré-preencher
            savedCalculations: savedCalculations,
            success: null,
            editMode: true, // Flag para indicar modo de edição
            editingId: calculoId, // ID do cálculo sendo editado
            editingName: calculo.name // Nome do cálculo sendo editado
        });
    } catch (error) {
        console.error('Erro ao carregar cálculo para edição:', error);
        res.status(500).send('Erro ao carregar cálculo');
    }
});

// Rota para o Relatório Da Vinci (Proposta)
app.get('/da-vinci', isAuthenticated, async (req, res) => {
    try {
        const savedCalculations = await db.all('SELECT * FROM saved_calculations WHERE user_id = ? ORDER BY id DESC', [req.session.userId]);

        res.render('da-vinci', {
            user: getUserContext(req.session),
            savedCalculations: savedCalculations
        });
    } catch (error) {
        console.error('Erro ao carregar Relatório Da Vinci:', error);
        res.status(500).send("Erro ao carregar a página.");
    }
});


app.post('/calculadora/salvar', isAuthenticated, [
    body('calculationName').notEmpty().withMessage('O nome do cálculo é obrigatório.')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        // Idealmente, renderizar a página da calculadora novamente com o erro
        return res.status(400).redirect('/calculadora?error=missing_name');
    }

    const { calculationName, calculationId, ...inputDataRaw } = req.body;

    // --- CORREÇÃO INICIA AQUI ---
    // Preserva os dados do formulário como estão, apenas garantindo que não haja valores indefinidos.
    // A conversão para número será feita quando os dados forem usados, não ao salvar.
    const inputData = { ...inputDataRaw };
    // --- FIM DA CORREÇÃO ---

    try {
        if (calculationId) {
            // Atualizar cálculo existente
            await db.run(
                'UPDATE saved_calculations SET name = ?, data = ? WHERE id = ? AND user_id = ?',
                [calculationName, JSON.stringify(inputData), calculationId, req.session.userId]
            );
        } else {
            // Salvar novo cálculo
            await db.run(
                `INSERT INTO saved_calculations(user_id, name, data) VALUES(?, ?, ?)`,
                [req.session.userId, calculationName, JSON.stringify(inputData)] // Salva o objeto de dados brutos
            );
        }

        // Apenas salva o cálculo e redireciona. 
        // A importação para a carteira agora é feita manualmente via "Meus Imóveis" -> "Carregar Cálculo".

        return res.redirect('/calculadora?success=saved');
    } catch (error) {
        console.error('Erro ao salvar cálculo:', error);
        res.status(500).send("Erro ao salvar o cálculo.");
    }
});

// -----------------------------------
// Novas Funcionalidades (DESATIVADAS)
// -----------------------------------

// app.get('/loja', isAuthenticated, (req, res) => {
//     res.render('loja', {
//         user: {
//             username: req.session.username,
//             profile_pic_url: req.session.profile_pic_url,
//             email: req.session.email
//         }
//     });
// });

// app.get('/mineracao', isAuthenticated, (req, res) => {
//     res.render('mineracao', {
//         user: {
//             username: req.session.username,
//             profile_pic_url: req.session.profile_pic_url,
//             email: req.session.email
//         }
//     });
// });

// app.get('/mineracao/navegador', isAuthenticated, (req, res) => {
//     res.render('mineracao_browser', {
//         user: {
//             username: req.session.username,
//             profile_pic_url: req.session.profile_pic_url,
//             email: req.session.email
//         }
//     });
// });

// -----------------------------------
// Carteira / Dashboard do Lead
// -----------------------------------



// ========================================
// ROTAS DE API - CLIENTES
// ========================================

// Rotas de Clientes Modularizadas
app.use('/', (await import('./routes/clientes.js')).default);

// Rota de Carteira Modularizada
app.use('/', (await import('./routes/carteira.js')).default);

// ========================================
// Rota de Leads e Financeiro Modularizada
app.use('/', (await import('./routes/financeiro_leads.js')).default);


// Rota para exportar leads como CSV
app.get('/api/leads/export', isAuthenticated, async (req, res) => {
    try {
        const leads = await db.all('SELECT * FROM leads ORDER BY created_at DESC');

        if (!leads || leads.length === 0) {
            return res.status(404).send('Nenhum lead encontrado para exportação.');
        }

        // Cabeçalho do CSV
        const header = [
            'ID', 'Nome', 'WhatsApp', 'Objetivo', 'Experiencia', 'Restricao Nome',
            'Capital Entrada', 'Capital Vista', 'Preferencia Pgto', 'Estado', 'Cidade',
            'Score', 'Status', 'IP Address', 'Data Criacao'
        ];

        // Construir linhas
        const rows = leads.map(lead => [
            lead.id,
            `"${(lead.nome || '').replace(/"/g, '""')}"`, // Escapar aspas duplas
            `"${(lead.whatsapp || '').replace(/"/g, '""')}"`,
            lead.objetivo,
            lead.experiencia,
            lead.restricao_nome ? 'Sim' : 'Nao',
            lead.capital_entrada,
            lead.capital_vista,
            lead.preferencia_pgto,
            lead.estado,
            `"${(lead.cidade || '').replace(/"/g, '""')}"`,
            lead.score,
            lead.status,
            lead.ip_address,
            lead.created_at
        ]);

        // Juntar tudo em uma string CSV
        const csvContent = [
            header.join(','),
            ...rows.map(r => r.join(','))
        ].join('\n');

        // Configurar headers para download
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="leads_export_${Date.now()}.csv"`);

        res.status(200).send(csvContent);
    } catch (error) {
        console.error('Erro ao exportar leads:', error);
        res.status(500).send('Erro ao gerar exportação.');
    }
});

// Aplicar rate limiter em todas as rotas /api/*
app.use('/api/', apiLimiter);



// --- Middleware de Tratamento de Erros (deve ser o último middleware) ---
app.use((err, req, res, next) => {
    console.error(err.stack);
    // Evita vazar detalhes do erro em produção
    res.status(500).send('Ocorreu um erro inesperado no servidor.');
});

// --- Inicialização do Servidor ---
(async () => {
    // ensureTables runs via top-level await at line 473

    



// Rota de Debug de Emergência
app.get('/api/debug-db', async (req, res) => {
    try {
        const stats = await db.all("SELECT status, count(*) as total FROM leads GROUP BY status");
        const latest = await db.all("SELECT * FROM leads ORDER BY created_at DESC LIMIT 5");
        res.json({ 
            database_path: '/var/www/macos/db/database.sqlite',
            stats: stats,
            latest_leads: latest,
            message: "Se stats estiver vazio, o banco está sendo lido de outro lugar ou está vazio."
        });
    } catch (e) {
        res.json({ error: e.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
});
})();