# YouTube Prospector

App web para encontrar criadores do YouTube com potencial para contratar editores de reels/vídeos.

## Como usar

1. Crie um arquivo `.env` na raiz do projeto.
2. Adicione as chaves:

```env
YOUTUBE_API_KEY=AIzaSyA7lhc3zB7gZVQy-V5k_dRLNj7FD1VAAbA
OPENAI_API_KEY=sua_chave_aqui
PORT=3000
```

3. Instale as dependências:

```bash
npm install
```

4. Inicie o servidor:

```bash
npm start
```

5. Abra `http://localhost:3000` no navegador.

## Funcionalidades

- Busca canais por nicho, idioma e tamanho
- Analisa frequência de upload e padrão de edição aparente
- Filtra canais ativos com edição simples ou inconsistente
- Usa OpenAI (`gpt-5-mini`) para gerar score, justificativa e mensagem de abordagem
- Exibe resultados em cards com botão de copiar mensagem

## Notas

- Requer Node.js 18+
- Usa timeout de 10s nas chamadas HTTP
- Trata erros básicos de cota do YouTube e da OpenAI
