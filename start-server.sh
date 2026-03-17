#!/bin/bash

# Script para iniciar o servidor garantindo que não há processos duplicados

echo "🔍 Verificando processos Node.js existentes..."

# Mata qualquer processo node server.js ou node --watch server.js
pkill -f "node.*server.js" 2>/dev/null

# Aguarda um momento para garantir que os processos foram encerrados
sleep 1

# Verifica se a porta 3000 está livre
if lsof -ti:3000 > /dev/null 2>&1; then
    echo "⚠️  Porta 3000 ainda em uso. Liberando..."
    lsof -ti:3000 | xargs kill -9 2>/dev/null
    sleep 1
fi

echo "✅ Iniciando servidor..."
node server.js
