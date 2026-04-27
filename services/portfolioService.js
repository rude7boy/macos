import db from '../config/database.js';

// Helper: Consolidated Portfolio Data Fetching & Healing
async function getPortfolioData(userId) {
    // 1. Fetch Imoveis with Aggregated Costs
    const imoveis = await db.all(`
        SELECT
        i.*,
            (i.valor_compra + IFNULL((SELECT SUM(c.valor) FROM carteira_custos c WHERE c.imovel_id = i.id), 0)) as total_investido,
    IFNULL((SELECT SUM(c.valor) FROM carteira_custos c WHERE c.imovel_id = i.id), 0) as total_custos
        FROM carteira_imoveis i
        WHERE i.user_id = ?
    ORDER BY i.data_aquisicao DESC
    `, [userId]);

    // 2. Fetch Helper Data for Healing
    const savedCalcs = await db.all('SELECT data FROM saved_calculations WHERE user_id = ? ORDER BY id DESC', [userId]);
    const arremates = await db.all('SELECT descricao_imovel, calc_valor_venda FROM arremates WHERE user_id = ?', [userId]);

    // 3. Deep Healing Logic (In-Memory & DB Update)
    for (let imovel of imoveis) {
        let dataUpdated = false;

        // Check if vital financial data is missing
        const needsHealing = (!imovel.valor_venda_estimado || imovel.valor_venda_estimado === 0) ||
            (!imovel.condominio_estimado || imovel.condominio_estimado === 0) ||
            (!imovel.iptu_estimado || imovel.iptu_estimado === 0);

        if (needsHealing) {
            // Level 1: Match by Description in Arremates
            const arremate = arremates.find(a => a.descricao_imovel === imovel.descricao);
            if (arremate && arremate.calc_valor_venda > 0) {
                if (!imovel.valor_venda_estimado) {
                    imovel.valor_venda_estimado = arremate.calc_valor_venda;
                    dataUpdated = true;
                }
            }

            // Level 2: Match by Price in Saved Calculations (Legacy Recovery)
            // Check again if we still miss data after L1
            const stillNeedsCosts = (!imovel.condominio_estimado || imovel.condominio_estimado === 0) ||
                (!imovel.iptu_estimado || imovel.iptu_estimado === 0) ||
                (!imovel.valor_venda_estimado || imovel.valor_venda_estimado === 0);

            if (stillNeedsCosts) {
                const match = savedCalcs.find(sc => {
                    const data = JSON.parse(sc.data);
                    return Math.abs(parseFloat(data.valorArrematado) - imovel.valor_compra) < 1.0;
                });

                if (match) {
                    const data = JSON.parse(match.data);

                    if ((!imovel.valor_venda_estimado || imovel.valor_venda_estimado === 0) && data.valorVendaFinal) {
                        imovel.valor_venda_estimado = parseFloat(data.valorVendaFinal);
                        dataUpdated = true;
                    }
                    if (!imovel.condominio_estimado && data.condominioMensal) {
                        imovel.condominio_estimado = parseFloat(data.condominioMensal);
                        dataUpdated = true;
                    }
                    if (!imovel.iptu_estimado) {
                        let iptu = parseFloat(data.iptuMensal) || 0;
                        if (!iptu && data.iptuAnual) iptu = parseFloat(data.iptuAnual) / 12;
                        if (iptu > 0) {
                            imovel.iptu_estimado = iptu;
                            dataUpdated = true;
                        }
                    }
                }
            }
        }

        // Persist updates if healing occurred
        if (dataUpdated) {
            await db.run(
                'UPDATE carteira_imoveis SET valor_venda_estimado = ?, condominio_estimado = ?, iptu_estimado = ? WHERE id = ?',
                [imovel.valor_venda_estimado, imovel.condominio_estimado || 0, imovel.iptu_estimado || 0, imovel.id]
            );

            // Ensure Monthly Costs exist in Costs Table (Self-healing)
            const today = new Date().toISOString().split('T')[0];

            if (imovel.condominio_estimado > 0) {
                const hasCond = await db.get('SELECT id FROM carteira_custos WHERE imovel_id = ? AND tipo_custo = "Condomínio"', [imovel.id]);
                if (!hasCond) {
                    await db.run('INSERT INTO carteira_custos (user_id, imovel_id, tipo_custo, valor, data_custo, descricao) VALUES (?, ?, ?, ?, ?, ?)',
                        [userId, imovel.id, 'Condomínio', imovel.condominio_estimado, today, 'Condomínio (Recuperado)']);
                    console.log(`🔧 Healing: Added missing Condomínio cost for Imovel ${imovel.id}`);
                }
            }
            if (imovel.iptu_estimado > 0) {
                // Check if any IPTU related cost exists
                const hasIPTU = await db.get('SELECT id FROM carteira_custos WHERE imovel_id = ? AND tipo_custo = "Impostos" AND (descricao LIKE "%IPTU%" OR valor = ?)', [imovel.id, imovel.iptu_estimado]);
                if (!hasIPTU) {
                    await db.run('INSERT INTO carteira_custos (user_id, imovel_id, tipo_custo, valor, data_custo, descricao) VALUES (?, ?, ?, ?, ?, ?)',
                        [userId, imovel.id, 'Impostos', imovel.iptu_estimado, today, 'IPTU (Recuperado)']);
                    console.log(`🔧 Healing: Added missing IPTU cost for Imovel ${imovel.id}`);
                }
            }
        }
    }

    // 4. Calculate KPIs
    let totalInvestidoGeral = 0;
    let totalInvestidoComEstimativa = 0;
    let lucroPotencialGeral = 0;
    let totalRecorrenteMensal = 0;

    imoveis.forEach(imovel => {
        const investido = parseFloat(imovel.total_investido) || 0;
        const vendaEstimada = parseFloat(imovel.valor_venda_estimado) || 0;

        totalInvestidoGeral += investido;

        if (vendaEstimada > 0) {
            totalInvestidoComEstimativa += investido;
            const corretagem = vendaEstimada * 0.06;
            const lucroBruto = vendaEstimada - corretagem - investido;
            const imposto = lucroBruto > 0 ? lucroBruto * 0.15 : 0;
            const lucroLiquido = lucroBruto - imposto;

            lucroPotencialGeral += lucroLiquido;
            imovel.lucro_liquido_estimado = lucroLiquido;
            imovel.roi_estimado = investido > 0 ? (lucroLiquido / investido) * 100 : 0;
        } else {
            imovel.lucro_liquido_estimado = 0;
            imovel.roi_estimado = 0;
        }

        const cond = parseFloat(imovel.condominio_estimado) || 0;
        const iptu = parseFloat(imovel.iptu_estimado) || 0;
        totalRecorrenteMensal += (cond + iptu);
    });

    const kpis = {
        total_investido: totalInvestidoGeral,
        lucro_potencial: lucroPotencialGeral,
        roi_medio: totalInvestidoComEstimativa > 0 ? ((lucroPotencialGeral / totalInvestidoComEstimativa) * 100).toFixed(1) : 0,
        total_imoveis: imoveis.length,
        custo_recorrente_mensal: totalRecorrenteMensal
    };

    // 5. Fetch Monthly Costs History
    const custosPorMes = await db.all(`
        SELECT strftime('%Y-%m', data_custo) as mes, SUM(valor) as total
        FROM carteira_custos
        WHERE user_id = ? AND data_custo >= date('now', '-12 months')
        GROUP BY mes
        ORDER BY mes ASC
    `, [userId]);

    // 6. Calculate Monthly Growth Data (Last 6 Months) for Advisor Performance
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

    imoveis.forEach(imovel => {
        if (imovel.data_aquisicao && imovel.lucro_liquido_estimado) {
            try {
                const dateVal = new Date(imovel.data_aquisicao);
                if (!isNaN(dateVal.getTime())) {
                    const dateKey = dateVal.toISOString().slice(0, 7);
                    if (months[dateKey]) {
                        months[dateKey].profit += parseFloat(imovel.lucro_liquido_estimado);
                        months[dateKey].volume += 1;
                    }
                }
            } catch (e) {
                console.warn(`Data inválida para imóvel ${imovel.id}: `, imovel.data_aquisicao);
            }
        }
    });

    const growthData = {
        labels: Object.values(months).map(m => m.label),
        profitData: Object.values(months).map(m => m.profit),
        volumeData: Object.values(months).map(m => m.volume)
    };

    return { imoveis, kpis, custosPorMes, growthData };
}

export { getPortfolioData };
