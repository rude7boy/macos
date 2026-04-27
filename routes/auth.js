import express from 'express';
import db from '../config/database.js';
import { scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import rateLimit from 'express-rate-limit';

const scryptAsync = promisify(scrypt);
const router = express.Router();

// --- Configuration ---
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// --- Password Security Helpers ---
const verifyPassword = async (password, storedHash) => {
    if (!storedHash) return false;
    const [salt, key] = storedHash.split(':');
    if (!salt || !key) return false;
    const keyBuffer = Buffer.from(key, 'hex');
    const derivedKey = await scryptAsync(password, salt, 64);
    return timingSafeEqual(keyBuffer, derivedKey);
};

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: 'Muitas tentativas de login. Tente novamente mais tarde.'
});

// Rota de Login
router.get('/login', (req, res) => {
    res.render('login', { message: req.query.message || null, error: req.query.error || null });
});

// Processar Login (Local)
router.post('/login', authLimiter, async (req, res) => {
    const { username, password } = req.body;
    try {
        // Tenta buscar por email ou username
        const user = await db.get('SELECT * FROM users WHERE email = ? OR username = ?', [username, username]);

        if (!user) {
            return res.render('login', { message: null, error: 'Usuário ou senha incorretos.' });
        }

        // Verifica senha
        // Nota: Usuários migrados do Supabase sem senha definida no DB local não conseguirão logar por senha até redefinirem.
        const isValid = await verifyPassword(password, user.password);
        if (!isValid) {
            return res.render('login', { message: null, error: 'Usuário ou senha incorretos.' });
        }

        // Cria sessão
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.email = user.email;
        req.session.profile_pic_url = user.profile_pic_url;
        req.session.isAdmin = !!(user.is_admin || (user.email && ADMIN_EMAILS.includes(user.email.toLowerCase())));

        console.log('🔐 Login bem-sucedido:', {
            email: user.email,
            is_admin_db: user.is_admin,
            in_admin_list: user.email && ADMIN_EMAILS.includes(user.email.toLowerCase()),
            final_isAdmin: req.session.isAdmin
        });

        res.redirect('/');
    } catch (err) {
        console.error('Login Error:', err);
        // Debug: Mostrando erro real para o usuário
        res.render('login', { message: null, error: 'Erro: ' + err.message });
    }
});

// Logout Route
router.post('/logout', (req, res) => {
    res.redirect('/');
});

router.get('/logout', (req, res) => {
    res.redirect('/');
});

export default router;
