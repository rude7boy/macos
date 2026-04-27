import express from 'express';
import db from '../config/database.js';

const router = express.Router();

// Middleware de autenticação simulado ou importado
const isAuthenticated = (req, res, next) => {
    if (req.session && req.session.userId) return next();
    return res.status(401).json({ success: false, error: 'Não autorizado' });
};

// Listar todos os clientes do assessor
router.get('/api/clientes', isAuthenticated, async (req, res) => {
    try {
        const clientes = await db.all(`
SELECT
c.*,
    COUNT(DISTINCT ci.id) as total_imoveis,
    COALESCE(SUM(ci.valor_compra), 0) as total_investido,
    COALESCE(SUM(ci.valor_venda_estimado), 0) as total_valor_venda
            FROM clientes c
            LEFT JOIN carteira_imoveis ci ON c.id = ci.cliente_id
            WHERE c.assessor_id = ?
    GROUP BY c.id
            ORDER BY c.created_at DESC
    `, [req.session.userId]);

        // Calcular ROI médio para cada cliente
        const clientesComROI = await Promise.all(clientes.map(async (cliente) => {
            const imoveis = await db.all(
                'SELECT * FROM carteira_imoveis WHERE cliente_id = ?',
                [cliente.id]
            );

            let totalROI = 0;
            let countROI = 0;

            for (const imovel of imoveis) {
                const custos = await db.all(
                    'SELECT SUM(valor) as total FROM carteira_custos WHERE imovel_id = ?',
                    [imovel.id]
                );
                const totalCustos = custos[0]?.total || 0;
                const totalInvestido = (imovel.valor_compra || 0) + totalCustos;
                const valorVenda = imovel.valor_venda_estimado || 0;

                if (valorVenda > 0 && totalInvestido > 0) {
                    const corretagem = valorVenda * 0.06;
                    const lucroBruto = valorVenda - corretagem - totalInvestido;
                    const imposto = lucroBruto > 0 ? lucroBruto * 0.15 : 0;
                    const lucroLiquido = lucroBruto - imposto;
                    const roi = (lucroLiquido / totalInvestido) * 100;
                    totalROI += roi;
                    countROI++;
                }
            }

            return {
                ...cliente,
                roi_medio: countROI > 0 ? totalROI / countROI : 0
            };
        }));

        res.json({ success: true, clientes: clientesComROI });
    } catch (error) {
        console.error('Erro ao listar clientes:', error);
        res.status(500).json({ success: false, error: 'Erro ao listar clientes' });
    }
});

// Criar novo cliente
router.post('/api/clientes', isAuthenticated, async (req, res) => {
    try {
        const { nome, cpf, email, telefone, status, data_inicio, observacoes } = req.body;

        if (!nome) {
            return res.status(400).json({ success: false, error: 'Nome é obrigatório' });
        }

        const result = await db.run(`
            INSERT INTO clientes(assessor_id, nome, cpf, email, telefone, status, data_inicio, observacoes)
VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    `, [
            req.session.userId,
            nome,
            cpf || null,
            email || null,
            telefone || null,
            status || 'ativo',
            data_inicio || new Date().toISOString().split('T')[0],
            observacoes || null
        ]);

        const clienteId = result.lastID || result.stmt?.lastID;

        res.json({ success: true, clienteId });
    } catch (error) {
        console.error('Erro ao criar cliente:', error);
        res.status(500).json({ success: false, error: 'Erro ao criar cliente' });
    }
});



// Obter detalhes de um cliente específico
router.get('/api/clientes/:id', isAuthenticated, async (req, res) => {
    try {
        const clienteId = req.params.id;

        const cliente = await db.get(
            'SELECT * FROM clientes WHERE id = ? AND assessor_id = ?',
            [clienteId, req.session.userId]
        );

        if (!cliente) {
            return res.status(404).json({ success: false, error: 'Cliente não encontrado' });
        }

        res.json({ success: true, cliente });
    } catch (error) {
        console.error('Erro ao obter cliente:', error);
        res.status(500).json({ success: false, error: 'Erro ao obter cliente' });
    }
});

// Atualizar cliente
router.put('/api/clientes/:id', isAuthenticated, async (req, res) => {
    try {
        const clienteId = req.params.id;
        const { nome, cpf, email, telefone, status, data_inicio, observacoes } = req.body;

        // Verificar se o cliente pertence ao assessor
        const cliente = await db.get(
            'SELECT id FROM clientes WHERE id = ? AND assessor_id = ?',
            [clienteId, req.session.userId]
        );

        if (!cliente) {
            return res.status(404).json({ success: false, error: 'Cliente não encontrado' });
        }

        await db.run(`
            UPDATE clientes 
            SET nome = ?, cpf = ?, email = ?, telefone = ?, status = ?,
    data_inicio = ?, observacoes = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
    `, [nome, cpf, email, telefone, status, data_inicio, observacoes, clienteId]);

        res.json({ success: true });
    } catch (error) {
        console.error('Erro ao atualizar cliente:', error);
        res.status(500).json({ success: false, error: 'Erro ao atualizar cliente' });
    }
});

// Deletar cliente
router.delete('/api/clientes/:id', isAuthenticated, async (req, res) => {
    try {
        const clienteId = req.params.id;

        // Verificar se o cliente pertence ao assessor e pegar dados para liberar lead
        const cliente = await db.get(
            'SELECT * FROM clientes WHERE id = ? AND assessor_id = ?',
            [clienteId, req.session.userId]
        );

        if (!cliente) {
            return res.status(404).json({ success: false, error: 'Cliente não encontrado' });
        }

        // Verificar se há imóveis vinculados
        const imoveis = await db.get(
            'SELECT COUNT(*) as count FROM carteira_imoveis WHERE cliente_id = ?',
            [clienteId]
        );

        if (imoveis.count > 0) {
            return res.status(400).json({
                success: false,
                error: 'Não é possível deletar cliente com imóveis vinculados. Remova os imóveis primeiro.'
            });
        }

        // Se este cliente veio de um lead (identificado pelo telefone), devolve o lead para a piscina ('novo')
        if (cliente.telefone) {
            await db.run(`
                UPDATE leads 
                SET status = 'novo', claimed_by = NULL 
                WHERE whatsapp = ? AND claimed_by = ?
    `, [cliente.telefone, req.session.userId]);
        }

        await db.run('DELETE FROM clientes WHERE id = ?', [clienteId]);

        res.json({ success: true });
    } catch (error) {
        console.error('Erro ao deletar cliente:', error);
        res.status(500).json({ success: false, error: 'Erro ao deletar cliente' });
    }
});

// Deletar imóvel da carteira
router.delete('/api/carteira/:id', isAuthenticated, async (req, res) => {
    try {
        const imovelId = req.params.id;

        // Verificar se o imóvel pertence a um cliente do assessor
        const imovel = await db.get(`
            SELECT ci.id 
            FROM carteira_imoveis ci
            JOIN clientes c ON ci.cliente_id = c.id
            WHERE ci.id = ? AND c.assessor_id = ?
    `, [imovelId, req.session.userId]);

        // Fallback: verificar se pertence diretamente ao assessor (caso legado ou sem cliente)
        const imovelDireto = await db.get(
            'SELECT id FROM carteira_imoveis WHERE id = ? AND user_id = ?',
            [imovelId, req.session.userId]
        );

        if (!imovel && !imovelDireto) {
            return res.status(404).json({ success: false, error: 'Imóvel não encontrado ou acesso negado' });
        }

        // Deletar custos associados (se houver)
        await db.run('DELETE FROM carteira_custos WHERE imovel_id = ?', [imovelId]);

        // Deletar imóvel
        await db.run('DELETE FROM carteira_imoveis WHERE id = ?', [imovelId]);

        res.json({ success: true, message: 'Imóvel excluído com sucesso' });
    } catch (error) {
        console.error('Erro ao excluir imóvel:', error);
        res.status(500).json({ success: false, error: 'Erro ao excluir imóvel' });
    }
});

// Dashboard do cliente específico
router.get('/api/clientes/:id/dashboard', isAuthenticated, async (req, res) => {
    try {
        const clienteId = req.params.id;

        // Verificar se o cliente pertence ao assessor
        const cliente = await db.get(
            'SELECT * FROM clientes WHERE id = ? AND assessor_id = ?',
            [clienteId, req.session.userId]
        );

        if (!cliente) {
            return res.status(404).json({ success: false, error: 'Cliente não encontrado' });
        }

        // Buscar imóveis do cliente
        const imoveis = await db.all(
            'SELECT * FROM carteira_imoveis WHERE cliente_id = ?',
            [clienteId]
        );

        // Calcular KPIs
        let totalInvestido = 0;
        let totalLucroEstimado = 0;
        let totalROI = 0;
        let countROI = 0;
        let custosMensaisRecorrentes = 0;

        for (const imovel of imoveis) {
            const custos = await db.all(
                'SELECT SUM(valor) as total FROM carteira_custos WHERE imovel_id = ?',
                [imovel.id]
            );
            const totalCustos = custos[0]?.total || 0;
            const investidoImovel = (imovel.valor_compra || 0) + totalCustos;
            totalInvestido += investidoImovel;

            // Priorizar valores salvos no banco (lucro_estimado e roi_estimado)
            let lucroLiquido = 0;
            let roi = 0;

            if (imovel.lucro_estimado !== null && imovel.lucro_estimado !== undefined && imovel.lucro_estimado !== 0) {
                // Usar valor salvo do banco
                lucroLiquido = imovel.lucro_estimado;
                totalLucroEstimado += lucroLiquido;
            } else {
                // Fallback: calcular manualmente se não houver valor salvo
                const valorVenda = imovel.valor_venda_estimado || 0;
                if (valorVenda > 0) {
                    const corretagem = valorVenda * 0.06;
                    const lucroBruto = valorVenda - corretagem - investidoImovel;
                    const imposto = lucroBruto > 0 ? lucroBruto * 0.15 : 0;
                    lucroLiquido = lucroBruto - imposto;
                    totalLucroEstimado += lucroLiquido;
                }
            }

            // ROI: priorizar valor salvo
            if (imovel.roi_estimado !== null && imovel.roi_estimado !== undefined && imovel.roi_estimado !== 0) {
                roi = imovel.roi_estimado;
                totalROI += roi;
                countROI++;
            } else if (investidoImovel > 0 && lucroLiquido !== 0) {
                // Fallback: calcular ROI manualmente
                roi = (lucroLiquido / investidoImovel) * 100;
                totalROI += roi;
                countROI++;
            }

            // Custos mensais recorrentes
            custosMensaisRecorrentes += (imovel.condominio_estimado || 0) + (imovel.iptu_estimado || 0);
        }

        const kpis = {
            totalInvestido,
            totalLucroEstimado,
            roiMedio: countROI > 0 ? totalROI / countROI : 0,
            totalImoveis: imoveis.length,
            custosMensaisRecorrentes
        };

        res.json({ success: true, cliente, kpis, imoveis });
    } catch (error) {
        console.error('Erro ao obter dashboard do cliente:', error);
        res.status(500).json({ success: false, error: 'Erro ao obter dashboard' });
    }
});



export default router;
