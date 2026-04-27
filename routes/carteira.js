import express from 'express';
import db from '../config/database.js';
import { getPortfolioData } from '../services/portfolioService.js';
import { parseMonetary } from '../utils.js'; // Might be needed

const router = express.Router();

const isAuthenticated = (req, res, next) => {
    if (req.session && req.session.userId) return next();
    return res.redirect('/login');
};

const getUserContext = (session) => {
    return {
        username: session.username || 'Usuário',
        email: session.email || 'Sem email',
        profile_pic_url: session.profile_pic_url || null,
        isAdmin: session.isAdmin || false
    };
};

// ========================================
// ROTAS DE CARTEIRA (MODIFICADAS)
// ========================================

// Página da carteira (dashboard) - Server-Side Rendering

router.get('/carteira', isAuthenticated, async (req, res) => {
    try {
        // Buscar todos os clientes do assessor com estatísticas
        const clientes = await db.all(`
            SELECT
c.*,
    COUNT(DISTINCT ci.id) as total_imoveis,
    COALESCE(SUM(ci.valor_compra), 0) as total_investido
            FROM clientes c
            LEFT JOIN carteira_imoveis ci ON c.id = ci.cliente_id
            WHERE c.assessor_id = ?
    GROUP BY c.id
            ORDER BY c.created_at DESC
    `, [req.session.userId]);

        // Calcular KPIs consolidados de todos os clientes
        let totalImoveisGeral = 0;
        let totalClientesAtivos = 0;
        let clientesComImoveis = 0;
        let novosClientesMes = 0;
        let totalROI = 0;
        let countROI = 0;
        let totalInvestidoPorCliente = 0;

        // Data de 30 dias atrás
        const dataLimite = new Date();
        dataLimite.setDate(dataLimite.getDate() - 30);

        for (const cliente of clientes) {
            if (cliente.status === 'ativo') totalClientesAtivos++;

            // Contar novos clientes no último mês
            const dataInicio = new Date(cliente.data_inicio || cliente.created_at);
            if (dataInicio >= dataLimite) {
                novosClientesMes++;
            }

            const imoveis = await db.all(
                'SELECT * FROM carteira_imoveis WHERE cliente_id = ?',
                [cliente.id]
            );

            if (imoveis.length > 0) {
                clientesComImoveis++;
            }

            totalImoveisGeral += imoveis.length;

            let totalInvestidoCliente = 0;
            let totalLucroCliente = 0;
            let totalROICliente = 0;
            let countROICliente = 0;

            for (const imovel of imoveis) {
                const custos = await db.all(
                    'SELECT SUM(valor) as total FROM carteira_custos WHERE imovel_id = ?',
                    [imovel.id]
                );
                const totalCustos = custos[0]?.total || 0;
                const investidoImovel = (imovel.valor_compra || 0) + totalCustos;
                totalInvestidoCliente += investidoImovel;

                const valorVenda = imovel.valor_venda_estimado || 0;
                if (valorVenda > 0 && investidoImovel > 0) {
                    const corretagem = valorVenda * 0.06;
                    const lucroBruto = valorVenda - corretagem - investidoImovel;
                    const imposto = lucroBruto > 0 ? lucroBruto * 0.15 : 0;
                    const lucroLiquido = lucroBruto - imposto;
                    const roi = (lucroLiquido / investidoImovel) * 100;

                    // Global Aggregation
                    totalROI += roi;
                    countROI++;

                    // Client Aggregation
                    totalLucroCliente += lucroLiquido;
                    totalROICliente += roi;
                    countROICliente++;
                }
            }

            if (totalInvestidoCliente > 0) {
                totalInvestidoPorCliente += totalInvestidoCliente;
            }

            // Attach metrics to client object for the view
            cliente.total_investido_real = totalInvestidoCliente;
            cliente.lucro_estimado = totalLucroCliente;
            cliente.roi_medio = countROICliente > 0 ? (totalROICliente / countROICliente) : 0;
        }

        const kpisGerais = {
            totalClientes: clientes.length,
            totalClientesAtivos,
            totalImoveis: totalImoveisGeral,
            clientesComImoveis,
            novosClientesMes,
            roiMedioGeral: countROI > 0 ? totalROI / countROI : 0,
            ticketMedio: clientesComImoveis > 0 ? totalInvestidoPorCliente / clientesComImoveis : 0
        };

        res.render('carteira', {
            user: getUserContext(req.session),
            clientes: clientes,
            kpis: kpisGerais
        });

    } catch (err) {
        console.error('Erro ao carregar dashboard de clientes:', err);
        res.status(500).send('Erro ao carregar dashboard de clientes.');
    }
});

// Nova rota: Carteira individual do cliente
router.get('/cliente/:id', isAuthenticated, async (req, res) => {
    try {
        const clienteId = req.params.id;

        // Verificar se o cliente pertence ao assessor
        const cliente = await db.get(
            'SELECT * FROM clientes WHERE id = ? AND assessor_id = ?',
            [clienteId, req.session.userId]
        );

        if (!cliente) {
            return res.status(404).send('Cliente não encontrado');
        }

        // Buscar imóveis do cliente
        const imoveis = await db.all(
            'SELECT * FROM carteira_imoveis WHERE cliente_id = ? ORDER BY data_aquisicao DESC',
            [clienteId]
        );

        // Calcular KPIs do cliente
        let totalInvestido = 0;
        let totalLucroEstimado = 0;
        let totalROI = 0;
        let countROI = 0;
        let custosMensaisRecorrentes = 0;

        const imoveisComDetalhes = [];

        for (const imovel of imoveis) {
            const custos = await db.all(
                'SELECT * FROM carteira_custos WHERE imovel_id = ? ORDER BY data_custo DESC',
                [imovel.id]
            );
            const totalCustos = custos.reduce((sum, c) => sum + (c.valor || 0), 0);
            const investidoImovel = (imovel.valor_compra || 0) + totalCustos;
            totalInvestido += investidoImovel;

            let lucroLiquido = 0;
            let roi = 0;

            // Priorizar valores salvos no banco
            if (imovel.lucro_estimado !== null && imovel.lucro_estimado !== undefined && imovel.lucro_estimado !== 0) {
                lucroLiquido = imovel.lucro_estimado;
                totalLucroEstimado += lucroLiquido;
            } else {
                // Fallback: calcular manualmente
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
                roi = (lucroLiquido / investidoImovel) * 100;
                totalROI += roi;
                countROI++;
            }

            // Custos mensais recorrentes
            const custosMensais = (imovel.condominio_estimado || 0) + (imovel.iptu_estimado || 0);
            custosMensaisRecorrentes += custosMensais;

            imoveisComDetalhes.push({
                ...imovel,
                totalCustos,
                totalInvestido: investidoImovel,
                lucroLiquido,
                roi,
                custosMensais
            });
        }

        // Buscar histórico de custos mensais
        const custosPorMes = await db.all(`
SELECT
strftime('%Y-%m', cc.data_custo) as mes,
    SUM(cc.valor) as total
            FROM carteira_custos cc
            INNER JOIN carteira_imoveis ci ON cc.imovel_id = ci.id
            WHERE ci.cliente_id = ?
    GROUP BY mes
            ORDER BY mes DESC
            LIMIT 12
        `, [clienteId]);

        const kpis = {
            totalInvestido,
            totalLucroEstimado,
            roiMedio: countROI > 0 ? totalROI / countROI : 0,
            totalImoveis: imoveis.length,
            custosMensaisRecorrentes
        };

        res.render('cliente-detalhes', {
            user: {
                username: req.session.username,
                profile_pic_url: req.session.profile_pic_url
            },
            cliente: cliente,
            imoveis: imoveisComDetalhes,
            kpis: kpis,
            custosPorMes: custosPorMes
        });

    } catch (err) {
        console.error('Erro ao carregar carteira do cliente:', err);
        res.status(500).send('Erro ao carregar carteira do cliente.');
    }
});

// Rota para página de detalhes do imóvel
router.get('/carteira/:id', isAuthenticated, async (req, res) => {
    try {
        const imovelId = req.params.id;

        // Buscar dados do imóvel
        const imovel = await db.get(
            'SELECT * FROM carteira_imoveis WHERE id = ? AND user_id = ?',
            [imovelId, req.session.userId]
        );

        if (!imovel) {
            return res.status(404).send('Imóvel não encontrado');
        }

        // Buscar custos do imóvel
        const custos = await db.all(
            'SELECT * FROM carteira_custos WHERE imovel_id = ? ORDER BY data_custo DESC',
            [imovelId]
        );

        // Buscar cliente associado ao imóvel (se houver)
        let cliente = null;
        if (imovel.cliente_id) {
            cliente = await db.get(
                'SELECT id, nome FROM clientes WHERE id = ? AND assessor_id = ?',
                [imovel.cliente_id, req.session.userId]
            );
        }

        // Calcular totais
        const totalCustos = custos.reduce((sum, c) => sum + (c.valor || 0), 0);
        const totalInvestido = (imovel.valor_compra || 0) + totalCustos;

        // Cálculo de Lucro Líquido (Padronizado)
        const valorVenda = imovel.valor_venda_estimado || 0;
        let lucroLiquido = 0;
        let roi = 0;

        if (valorVenda > 0) {
            const corretagem = valorVenda * 0.06;
            const lucroBruto = valorVenda - corretagem - totalInvestido;
            const imposto = lucroBruto > 0 ? lucroBruto * 0.15 : 0;
            lucroLiquido = lucroBruto - imposto;

            roi = totalInvestido > 0 ? (lucroLiquido / totalInvestido) * 100 : 0;
        }

        res.render('imovel-detalhes', {
            user: {
                username: req.session.username,
                profile_pic_url: req.session.profile_pic_url
            },
            imovel: imovel,
            cliente: cliente, // Adiciona cliente ao contexto
            custos: custos,
            totais: {
                custos: totalCustos,
                investido: totalInvestido,
                lucro: lucroLiquido,
                roi: roi
            }
        });

    } catch (err) {
        console.error('Erro ao carregar detalhes do imóvel:', err);
        res.status(500).send('Erro ao carregar detalhes do imóvel.');
    }
});



// Rota para editar imóvel da carteira
router.get('/carteira/edit/:id', isAuthenticated, async (req, res) => {
    try {
        const imovel = await db.get('SELECT * FROM carteira_imoveis WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId]);
        if (!imovel) {
            return res.status(404).send("Imóvel não encontrado.");
        }
        res.render('editar-imovel', {
            imovel: imovel,
            user: {
                username: req.session.username,
                profile_pic_url: req.session.profile_pic_url
            }
        });
    } catch (error) {
        console.error('Erro ao carregar imóvel para edição:', error);
        res.status(500).send("Erro ao carregar página de edição.");
    }
});

router.post('/carteira/edit/:id', isAuthenticated, async (req, res) => {
    const { descricao, endereco, status, valor_compra, valor_venda_estimado, data_aquisicao, observacoes, condominio_estimado, iptu_estimado } = req.body;

    // Helper para extrair números de strings formatadas (pt-BR) ou números puros
    const parseMonetary = (val) => {
        if (val === null || val === undefined || val === '') return 0;
        if (typeof val === 'number') return val;

        const strVal = val.toString().trim();

        // Se tiver vírgula, assume formato BRL (Ex: "1.000,00" ou "10,50")
        if (strVal.includes(',')) {
            const clean = strVal.replace(/[^\d,-]/g, '');
            return parseFloat(clean.replace(',', '.')) || 0;
        }

        // Se NÃO tiver vírgula, assume formato Standard/US (Ex: "1000.00")
        const clean = strVal.replace(/[^\d.-]/g, '');
        return parseFloat(clean) || 0;
    };

    try {
        // Buscar custos existentes para cálculo preciso
        const custos = await db.all('SELECT valor FROM carteira_custos WHERE imovel_id = ?', [req.params.id]);
        const totalCustos = custos.reduce((sum, c) => sum + (c.valor || 0), 0);

        const vCompra = parseMonetary(valor_compra);
        const vVenda = parseMonetary(valor_venda_estimado);
        const investimentoTotal = vCompra + totalCustos;

        let lucroEstimado = 0;
        let roiEstimado = 0;

        if (vVenda > 0) {
            const corretagem = vVenda * 0.06;
            const lucroBruto = vVenda - corretagem - investimentoTotal;
            const imposto = lucroBruto > 0 ? lucroBruto * 0.15 : 0;
            lucroEstimado = lucroBruto - imposto;

            if (investimentoTotal > 0) {
                roiEstimado = (lucroEstimado / investimentoTotal) * 100;
            }
        }

        await db.run(
            `UPDATE carteira_imoveis 
             SET descricao = ?, endereco = ?, status = ?, valor_compra = ?, valor_venda_estimado = ?, data_aquisicao = ?, observacoes = ?, condominio_estimado = ?, iptu_estimado = ?, lucro_estimado = ?, roi_estimado = ?
    WHERE id = ? AND user_id = ? `,
            [
                descricao,
                endereco,
                status,
                vCompra, // Usar valor parseado
                vVenda,  // Usar valor parseado
                data_aquisicao,
                observacoes,
                parseMonetary(condominio_estimado),
                parseMonetary(iptu_estimado),
                lucroEstimado,
                roiEstimado,
                req.params.id,
                req.session.userId
            ]
        );
        res.redirect(`/ carteira / ${req.params.id} `);
    } catch (error) {
        console.error('Erro ao atualizar imóvel:', error);
        res.status(500).send("Erro ao salvar alterações.");
    }
});

// --- DEBUG ROUTE (Temporary) ---
router.get('/debug/force-heal', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.userId;
        const imoveis = await db.all('SELECT * FROM carteira_imoveis WHERE user_id = ?', [userId]);
        const savedCalcs = await db.all('SELECT * FROM saved_calculations WHERE user_id = ?', [userId]);
        const arremates = await db.all('SELECT * FROM arremates WHERE user_id = ?', [userId]);

        let logs = [];
        logs.push(`Found ${imoveis.length} imoveis, ${savedCalcs.length} saved calcs, ${arremates.length} arremates.`);

        for (let imovel of imoveis) {
            logs.push(`Checking Imovel ${imovel.id} (${imovel.descricao})...Venda: ${imovel.valor_venda_estimado}, Cond: ${imovel.condominio_estimado} `);

            // Level 1: Arremates
            const arremate = arremates.find(a => a.descricao_imovel === imovel.descricao);
            if (arremate) {
                logs.push(`  -> Found Arremate Match(L1): ID ${arremate.id}.Venda: ${arremate.calc_valor_venda} `);
                if (arremate.calc_valor_venda > 0) {
                    await db.run('UPDATE carteira_imoveis SET valor_venda_estimado = ? WHERE id = ?', [arremate.calc_valor_venda, imovel.id]);
                    logs.push(`  -> UPDATED Venda from Arremate.`);
                }
            } else {
                logs.push(`  -> No Arremate match for description '${imovel.descricao}'`);
            }

            // Level 2: Saved Calcs
            const match = savedCalcs.find(sc => {
                const data = JSON.parse(sc.data);
                return Math.abs(parseFloat(data.valorArrematado) - imovel.valor_compra) < 1.0;
            });

            if (match) {
                const data = JSON.parse(match.data);
                logs.push(`  -> Found SavedCalc Match(L2): ID ${match.id}.Venda: ${data.valorVendaFinal}, Cond: ${data.condominioMensal} `);

                await db.run('UPDATE carteira_imoveis SET valor_venda_estimado = ?, condominio_estimado = ?, iptu_estimado = ? WHERE id = ?',
                    [parseFloat(data.valorVendaFinal) || imovel.valor_venda_estimado,
                    parseFloat(data.condominioMensal) || imovel.condominio_estimado || 0,
                    (parseFloat(data.iptuMensal) || (parseFloat(data.iptuAnual) / 12)) || imovel.iptu_estimado || 0,
                    imovel.id]
                );
                logs.push(`  -> UPDATED Metrics from SavedCalc.`);
            } else {
                logs.push(`  -> No SavedCalc match for value ${imovel.valor_compra}`);
            }
        }
        res.json({ logs });
    } catch (e) {
        res.status(500).json({ error: e.message, stack: e.stack });
    }
});

// --- NOVAS ROTAS DA API DA CARTEIRA ---

// Dashboard Data (KPIs e Gráficos)
router.get('/api/portfolio/dashboard', isAuthenticated, async (req, res) => {
    try {
        const { imoveis, kpis, custosPorMes } = await getPortfolioData(req.session.userId);

        // Structure the response to match what the client expects
        // Client expects { ...kpis, custosPorMes: [], distribuicaoCustos: [] }

        // Fetch distribution separately as it (currently) wasn't in the helper but is needed here
        // Or we add it to the helper. For now let's keep it here or add to helper.
        // Let's add it here to keep helper focused on "Core Data".
        // Actually, the client uses `distribuicaoCustos`.

        const distribuicaoCustos = await db.all(`
            SELECT tipo_custo, SUM(valor) as total
            FROM carteira_custos
            WHERE user_id = ?
    GROUP BY tipo_custo
        `, [req.session.userId]);

        res.json({
            ...kpis,
            distribuicaoCustos,
            custosPorMes
        });
    } catch (err) {
        console.error('Erro no dashboard:', err);
        res.status(500).json({ error: 'Erro ao carregar dashboard' });
    }
});


// Listar todos os imóveis do portfólio
// Helper: Consolidated Portfolio Data Fetching & Healing
// (Already defined above)



export default router;
