import express from 'express';
import db from '../config/database.js';

const router = express.Router();

const isAuthenticated = (req, res, next) => {
    if (req.session && req.session.userId) return next();
    return res.redirect('/login');
};

const getUserContext = (session) => {
    return {
        id: session.userId,
        email: session.email,
        username: session.username,
        role: session.role || 'assessor',
        isAdmin: session.isAdmin || false
    };
};

// FUNIL DE VENDAS (LEAD GENERATION)
// ========================================

// Rota Pública do Funil
router.get('/start', (req, res) => {
    res.render('funnel');
});

// Processamento do Lead (API)
router.post('/api/leads/submit', async (req, res) => {
    try {
        const { nome, whatsapp, objetivo, experiencia, restricao_nome, capital_disponivel, preferencia_pgto, estado, cidade, interesse } = req.body;

        // --- Advanced Credit Score Algorithm (Bank Grade) ---
        // Desenvolvido para qualificar leads com precisão bancária
        let score = 0;
        const capital = parseFloat(capital_disponivel || 0);
        const isCash = preferencia_pgto === 'vista';
        const isRestricted = restricao_nome === 'true'; // Vem como string 'true'/'false' do form
        const hasExperience = experiencia === 'ja_arrematei';

        // 1. Capacidade Financeira (Peso: 50%) - O Fator mais crítico
        if (capital >= 1000000) score += 50;      // Whale (Baleia) - Atendimento VIP Imediato
        else if (capital >= 500000) score += 40;  // High Net Worth
        else if (capital >= 200000) score += 30;  // Standard Gold
        else if (capital >= 100000) score += 20;  // Entry Level
        else if (capital >= 50000) score += 10;   // Minimal Viable

        // 2. Perfil de Liquidez (Peso: 20%) - Velocidade de Fechamento
        if (isCash) {
            score += 20; // Cash is King - Sem dependência de bancos
        } else {
            // Financiado: Ciclo de venda 3x mais longo + Risco de reprovação
            score += 5;
        }

        // 3. Maturidade do Investidor (Peso: 20%) - Qualidade da Conversa
        if (hasExperience) {
            score += 20; // Já arrematou: Entende o processo, não precisa ser "educado"
        } else if (objetivo === 'investir') {
            score += 15; // Investidor racional: Decide por números
        } else {
            score += 5; // Moradia/Primeira vez: Compra emocional, muitas dúvidas
        }

        // 4. Qualidade dos Dados (Peso: 10%)
        if (whatsapp && whatsapp.replace(/\D/g, '').length >= 10) score += 5;
        if (estado && estado.length === 2 && cidade) score += 5;
        else if (cidade && cidade.length > 2) score += 3; // cidade sem estado vale parcial

        // --- Penalidades de Risco (Lógica de Bureau) ---
        if (isRestricted) {
            if (isCash) {
                // Se paga à vista, restrição importa pouco (apenas compliance/burocracia menor)
                score -= 5;
            } else {
                // Se quer financiar com nome sujo, a chance de êxito é < 5%
                // Penalidade severa para não iludir o time de vendas
                score -= 40;
            }
        }

        // --- Bônus por Produto / Interesse ---
        // Produtos de negócio (Promotor, Licenciado) = leads mais estratégicos
        if (interesse === 'promotor')                score += 30;
        else if (interesse === 'licenciado')         score += 25;
        else if (interesse === 'mentoria_individual') score += 20;
        else if (interesse === 'mentoria_online')    score += 15;
        else if (interesse === 'assessoria')         score += 10;
        else if (interesse === 'eventos')            score += 5;

        // Normalização (0 a 100)
        score = Math.min(100, Math.max(0, score));

        // Save to DB
        // Capturar dados de rastreamento
        const ip_address = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const fingerprint = req.body.fingerprint || null;

        await db.run(`
        INSERT INTO leads(
            nome, whatsapp, objetivo, experiencia, restricao_nome,
            capital_entrada, preferencia_pgto, estado, cidade, interesse, score,
            ip_address, fingerprint
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
            nome,
            whatsapp,
            objetivo,
            experiencia || 'primeira_vez',
            isRestricted ? 1 : 0,
            capital_disponivel || 0,
            preferencia_pgto || 'nao_informado',
            estado || '',
            cidade || '',
            interesse || 'nao_informado',
            score,
            ip_address,
            fingerprint
        ]);
        res.json({ success: true, score: score });

    } catch (error) {
        console.error('Erro ao salvar lead:', error);
        res.status(500).json({ success: false, error: 'Erro ao processar perfil.' });
    }
});

// ========================================

// ========================================
// ÁREA DO ASSESSOR (LEADS POOL)
// ========================================

// Rota de Histórico de Distribuição de Leads (Admin)
router.get('/admin/leads-history', isAuthenticated, async (req, res) => {
    try {
        const leads = await db.all(`
SELECT
l.*,
    u.username as assessor_nome,
    u.profile_pic_url as assessor_pic
            FROM leads l 
            LEFT JOIN users u ON l.claimed_by = u.id 
            WHERE l.status != 'novo' 
            ORDER BY l.updated_at DESC
    `);

        res.render('leads_history', {
            leads,
            user: { ...req.session, isAdmin: req.session.isAdmin },
            username: req.session.username,
            profile_pic_url: req.session.profile_pic_url
        });
    } catch (error) {
        console.error('Erro ao carregar histórico de leads:', error);
        res.status(500).send("Erro ao carregar histórico.");
    }
});

// Listar Leads Disponíveis (Piscina)
router.get('/leads', isAuthenticated, async (req, res) => {
    try {
        // Busca TODOS os leads com status 'novo'
        const allLeads = await db.all(`
            SELECT * FROM leads 
            WHERE status = 'novo' 
            ORDER BY created_at DESC
        `);

        // Calcular KPIs simplificados
        let kpis = {
            totalCapital: allLeads.reduce((sum, l) => sum + (l.capital_entrada || 0), 0),
            avgScore: allLeads.length > 0 ? Math.round(allLeads.reduce((sum, l) => sum + (l.score || 0), 0) / allLeads.length) : 0,
            totalLeads: allLeads.length,
            attentionCount: 0,
            blacklistCount: 0,
            blacklistClusterCount: 0,
            blacklistValue: 0,
            qualityLabel: 'N/A'
        };

        if (allLeads.length > 0) {
            if (kpis.avgScore >= 75) kpis.qualityLabel = 'Excelente 🌟';
            else if (kpis.avgScore >= 50) kpis.qualityLabel = 'Bom ✅';
            else kpis.qualityLabel = 'Regular ⚠️';
        }

        // --- PAGINATION LOGIC ---
        const page = parseInt(req.query.page) || 1;
        const limit = 100; // Aumentado para ver mais de uma vez
        const startIndex = (page - 1) * limit;
        const totalPages = Math.ceil(allLeads.length / limit);
        const paginatedLeads = allLeads.slice(startIndex, startIndex + limit);

        res.render('leads-pool', {
            leads: paginatedLeads, 
            blacklist: [], // Desativado
            rawBlacklist: [], // Desativado
            kpis: kpis,
            pagination: {
                current: page,
                total: totalPages,
                hasPrev: page > 1,
                hasNext: page < totalPages
            },
            user: getUserContext(req.session),
            username: req.session.username,
            profile_pic_url: req.session.profile_pic_url
        });
    } catch (error) {
        console.error('Erro ao listar leads:', error);
        res.status(500).send("Erro ao carregar leads.");
    }
});

// Puxar Lead (Claim)
router.post('/api/leads/claim/:id', isAuthenticated, async (req, res) => {
    try {
        const leadId = req.params.id;
        const advisorId = req.session.userId;

        // 1. Verifica se o lead ainda está disponível
        const lead = await db.get('SELECT * FROM leads WHERE id = ? AND status = "novo"', [leadId]);

        if (!lead) {
            return res.status(400).send('Lead não encontrado ou já assumido por outro assessor.');
        }

        // 2. Marca como 'contactado' na tabela leads e vincula ao assessor
        await db.run('UPDATE leads SET status = ?, claimed_by = ? WHERE id = ?', ['contactado', advisorId, leadId]);

        // 3. Cria automaticamente o registro na tabela 'clientes' do assessor
        await db.run(`
            INSERT INTO clientes(
    assessor_id, nome, email, telefone, status, data_inicio, observacoes
) VALUES(?, ?, ?, ?, 'ativo', date('now'), ?)
        `, [
            advisorId,
            lead.nome,
            'email@pendente.com', // Placeholder 
            lead.whatsapp,
            `Lead vindo do Funil(Score: ${lead.score}).Objetivo: ${lead.objetivo}.Capital: ${(lead.capital_entrada || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} `
        ]);

        console.log(`✅ Assessor ${advisorId} puxou o lead ${leadId} (${lead.nome})`);
        res.redirect('/leads'); // Recarrega a página

    } catch (error) {
        console.error('Erro ao puxar lead:', error);
        res.status(500).send("Erro ao processar sua solicitação.");
    }
});

// Rota API para buscar imóveis (consumida pelo front)
router.get('/api/portfolio/imoveis', isAuthenticated, async (req, res) => {
    try {
        const { imoveis } = await getPortfolioData(req.session.userId);
        res.json(imoveis);
    } catch (err) {
        console.error('Erro ao buscar imóveis:', err);
        res.status(500).json({ error: 'Erro ao buscar imóveis' });
    }
});

// Adicionar um novo imóvel
router.post('/api/portfolio/imoveis', isAuthenticated, async (req, res) => {
    try {
        const { descricao, endereco, valor_compra, data_aquisicao, valor_venda_estimado, lucro_estimado, roi_estimado } = req.body;
        if (!descricao) return res.status(400).json({ error: 'Descrição é obrigatória' });

        const result = await db.run(
            'INSERT INTO carteira_imoveis (user_id, descricao, endereco, valor_compra, data_aquisicao, valor_venda_estimado, lucro_estimado, roi_estimado) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [req.session.userId, descricao, endereco, valor_compra || 0, data_aquisicao || null, valor_venda_estimado || 0, lucro_estimado || 0, roi_estimado || 0]
        );
        res.status(201).json({ id: result.lastID });
    } catch (err) {
        console.error('Erro ao adicionar imóvel:', err);
        res.status(500).json({ error: 'Erro no servidor' });
    }
});

// Obter detalhes de um imóvel específico (incluindo custos)
router.get('/api/portfolio/imoveis/:id', isAuthenticated, async (req, res) => {
    try {
        const imovel = await db.get('SELECT * FROM carteira_imoveis WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId]);
        if (!imovel) return res.status(404).json({ error: 'Imóvel não encontrado' });

        const custos = await db.all('SELECT * FROM carteira_custos WHERE imovel_id = ? ORDER BY data_custo DESC', [req.params.id]);
        imovel.custos = custos;

        res.json(imovel);
    } catch (err) {
        console.error('Erro ao buscar detalhes do imóvel:', err);
        res.status(500).json({ error: 'Erro no servidor' });
    }
});

// Adicionar um custo a um imóvel
router.post('/api/portfolio/imoveis/:id/custos', isAuthenticated, async (req, res) => {
    try {
        const { tipo_custo, descricao, valor, data_custo } = req.body;
        console.log(`📝 Recebendo novo custo: Imóvel = ${req.params.id}, Tipo = ${tipo_custo}, Valor = ${valor}, Data = ${data_custo} `);
        if (!tipo_custo || !valor) return res.status(400).json({ error: 'Tipo e valor do custo são obrigatórios' });

        const today = new Date().toISOString().split('T')[0];
        const result = await db.run(
            'INSERT INTO carteira_custos (imovel_id, user_id, tipo_custo, descricao, valor, data_custo) VALUES (?, ?, ?, ?, ?, ?)',
            [req.params.id, req.session.userId, tipo_custo, descricao, valor, data_custo || today]
        );
        res.status(201).json({ id: result.lastID });
    } catch (err) {
        console.error('Erro ao adicionar custo:', err);
        res.status(500).json({ error: 'Erro no servidor' });
    }
});

// Deletar um custo
router.delete('/api/portfolio/custos/:id', isAuthenticated, async (req, res) => {
    try {
        // Garante que o custo pertence ao usuário logado
        const custo = await db.get('SELECT id FROM carteira_custos WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId]);
        if (!custo) return res.status(404).json({ error: 'Custo não encontrado' });

        await db.run('DELETE FROM carteira_custos WHERE id = ?', [req.params.id]);
        res.json({ ok: true });
    } catch (err) {
        console.error('Erro ao deletar custo:', err);
        res.status(500).json({ error: 'Erro no servidor' });
    }
});

// Lançar custos mensais (Condomínio + IPTU) para o mês atual
router.post('/api/portfolio/imoveis/:id/lancar-mensais', isAuthenticated, async (req, res) => {
    try {
        const imovelId = req.params.id;
        const imovel = await db.get('SELECT * FROM carteira_imoveis WHERE id = ? AND user_id = ?', [imovelId, req.session.userId]);

        if (!imovel) return res.status(404).json({ error: 'Imóvel não encontrado' });

        const today = new Date();
        const dataCusto = today.toISOString().split('T')[0];
        const mesAno = today.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
        const mesCapitalized = mesAno.charAt(0).toUpperCase() + mesAno.slice(1);

        let added = 0;

        // Lança Condomínio se houver estimativa
        if (imovel.condominio_estimado > 0) {
            await db.run(
                'INSERT INTO carteira_custos (imovel_id, user_id, tipo_custo, descricao, valor, data_custo) VALUES (?, ?, ?, ?, ?, ?)',
                [imovelId, req.session.userId, 'Condomínio', `Condomínio - ${mesCapitalized} `, imovel.condominio_estimado, dataCusto]
            );
            added++;
        }

        // Lança IPTU se houver estimativa
        if (imovel.iptu_estimado > 0) {
            await db.run(
                'INSERT INTO carteira_custos (imovel_id, user_id, tipo_custo, descricao, valor, data_custo) VALUES (?, ?, ?, ?, ?, ?)',
                [imovelId, req.session.userId, 'Impostos', `IPTU - ${mesCapitalized} `, imovel.iptu_estimado, dataCusto]
            );
            added++;
        }

        if (added > 0) {
            res.json({ success: true, message: `${added} custos lançados com sucesso.` });
        } else {
            res.status(400).json({ error: 'Nenhum valor estimado configurado para este imóvel.' });
        }

    } catch (err) {
        console.error('Erro ao lançar custos mensais:', err);
        res.status(500).json({ error: 'Erro no servidor' });
    }
});

// API para dados do Dashboard




// 4. Endpoint para "Arrematar" direto da oportunidade (Gera Carteira + Comissão Linkada)
// 4. Endpoint para "Arrematar" direto da oportunidade (Entra na carteira como "Em Andamento")
router.post('/api/oportunidades/:id/arrematar', isAuthenticated, async (req, res) => {
    try {
        const op = await db.get('SELECT * FROM oportunidades WHERE id = ?', [req.params.id]);
        if (!op) return res.status(404).json({ error: 'Op não encontrada' });

        const { cliente_id } = req.body;

        // Inserir na carteira do usuario logado (quem 'pegou' a oportunidade)
        // Status inicial: 'Em Andamento'
        // Salva quem minerou (op.user_id) em minerador_original_id
        await db.run(`
            INSERT INTO carteira_imoveis(
            user_id, descricao, endereco, valor_compra, valor_venda_estimado,
            status, lucro_estimado, roi_estimado, data_aquisicao, cliente_id
        )
VALUES(?, ?, ?, ?, ?, 'Em Andamento', ?, ?, ?, ?)
        `, [
            req.session.userId,
            op.titulo,
            (op.cidade + ' - ' + op.estado),
            op.valor_arremate,
            op.valor_venda,
            op.lucro_estimado,
            op.roi_estimado,
            new Date().toISOString().split('T')[0],
            cliente_id || null // Add client ID if provided
        ]);

        // Marcar OP como 'reservada' ou 'vendido'
        await db.run("UPDATE oportunidades SET status = 'vendido' WHERE id = ?", [op.id]);

        res.json({ success: true, message: 'Imóvel adicionado à carteira do cliente como "Em Andamento".' });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro ao processar' });
    }
});

// 5. Finalizar Arremate (Na Carteira) -> Gera Comissão
router.post('/api/carteira/:id/finalizar-arremate', isAuthenticated, async (req, res) => {
    try {
        const imovel = await db.get('SELECT * FROM carteira_imoveis WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId]);
        if (!imovel) return res.status(404).json({ error: 'Imovel não encontrado' });

        if (imovel.status === 'Arrematado') return res.status(400).json({ error: 'Já está arrematado' });

        // Atualiza status local
        await db.run("UPDATE carteira_imoveis SET status = 'Arrematado' WHERE id = ?", [req.params.id]);

        res.json({ success: true, message: 'Arremate confirmado!' });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Erro ao finalizar' });
    }
});


export default router;
