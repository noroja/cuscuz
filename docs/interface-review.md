# Cuscuz-MED — paleta escura e revisão Vercel

## Decisão visual

Retomar a identidade da captura enviada: azul profundo, painéis em azul ardósia, turquesa e ciano. As cores abaixo são uma adaptação da referência para um sistema consistente, não uma extração exata de todos os pixels da imagem.

| Papel | Cor | Onde aplicar |
|---|---|---|
| Fundo | `#080e17` | Moldura, cabeçalho e navegação |
| Superfície | `#101a29` | Área principal, entrada e campos |
| Painel | `#172335` | Resumos e grupos de conteúdo |
| Sobreposição | `#1c2b40` | Menus e camadas acima da tela |
| Borda discreta | `#26354a` | Separação estrutural |
| Borda de controle | `#60758e` | Campos e controles que precisam ser identificados |
| Texto principal | `#edf3fa` | Títulos, nomes e valores |
| Texto secundário | `#b7c7d9` | Descrições |
| Metadados | `#9aafc6` | Datas, durações e informações auxiliares |
| Turquesa | `#00d4b8` | Ação principal, foco e ícones selecionados |
| Ciano | `#37c5ed` | Progresso, com uso pontual |
| Texto sobre turquesa | `#052128` | Rótulo do botão principal |
| Seleção | `#103c40` | Fundo do destino ativo |

Minha recomendação é concentrar a área colorida nos fundos azuis e reservar o turquesa para decisões. Textos corridos em branco suave e cinza azulado sustentam sessões longas. O ciano diferencia o progresso sem criar uma segunda família de botões.

O turquesa recebe texto escuro para manter o contraste. Erro e aviso continuam com cores e rótulos próprios. A seleção combina fundo, texto e ícone: a cor não é a única indicação.

Foram mantidos a hierarquia, os espaçamentos e os caminhos simplificados da primeira reformulação. A preferência por azul profundo enviada pelo usuário prevalece sobre a recomendação genérica da taste skill de usar bases neutras no modo escuro. Não foram retomados brilhos, gradientes em todos os controles ou múltiplos destaques concorrentes da referência antiga.

O tema escuro passa a ser o padrão quando não existe uma escolha salva. O tema claro continua disponível, e uma escolha explícita anterior é respeitada.

## Skill e critérios aplicados

A [documentação indicada](https://github.com/vercel-labs/web-interface-guidelines) encaminha para a skill oficial [`web-design-guidelines`](https://github.com/vercel-labs/agent-skills/tree/main/skills/web-design-guidelines). Ela foi instalada em `C:/Users/Teste/.codex/skills/web-design-guidelines` e lida nesta sessão. As [regras atuais de revisão](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md) foram consultadas.

O trabalho aplicou critérios de contraste, foco, semântica de navegação, nomes acessíveis, atualização assíncrona, campos móveis, estado da URL, movimento reduzido e consistência do tema. As preferências de escrita específicas da marca Vercel não foram usadas para impor Title Case ou inglês ao produto brasileiro.

## Alterações desta rodada

- Paleta escura unificada no login, estrutura, plano, Mentor, acervo e controles que usam os tokens compartilhados.
- Metadados maiores nos resumos, evitando uma tela composta majoritariamente por textos muito pequenos.
- Links nativos nos destinos principais e nos atalhos do plano; abertura modificada com Ctrl/Cmd preservada.
- Destino da tela na URL, título contextual e retorno de rolagem no histórico.
- Nomes acessíveis preservados mesmo quando a navegação é recolhida.
- Perfil e acionador do tutorial como botões nativos.
- Tutorial com nome, descrição, retenção do foco, fechamento por Escape e retorno ao acionador.
- Enter insere linha no Mentor; Ctrl/Cmd+Enter envia. A composição por IME não é interceptada.
- Envio com indicação de processamento; rascunho, seleção e foco preservados durante a atualização da conversa.
- Campos móveis de 16 px, alvos maiores, seleção nativa com fundo/cor explícitos e área segura na navegação inferior.
- Cor do navegador e `color-scheme` acompanham o tema.

## Verificação

Build concluído. Testes existentes do provedor de IA e do planejador aprovados. Testes de navegação e os novos testes de contraste, histórico, foco e preservação do rascunho aprovados.

Os testes verificam contraste mínimo de 4,5:1 dos três níveis de texto sobre os quatro fundos escuros e do rótulo sobre a ação principal. O foco sobre painel também foi verificado. Isso valida essas combinações; não equivale a uma certificação de acessibilidade de todas as telas legadas.

Plano com dados demonstrativos e primeiro acesso inspecionados em **1440, 768 e 390 px: 0 falhas e 0 avisos** no inspetor da taste skill. As nove imagens de plano, primeiro acesso e login foram examinadas.

Login: 0 falhas; dois avisos do modo de inspeção de aplicativos sobre o título de marca maior e a coluna de formulário limitada. Mantidos por se tratar da entrada do produto, não de uma tela de trabalho.

Na aplicação local real, foram confirmados o destino do acervo, o título e a URL da tela, o botão Voltar e a retenção/retorno do foco no tutorial. Reprodução do Drive e geração real de plano continuam dependentes das configurações de serviço do ambiente de homologação.

As imagens com plano são demonstrações de layout. Nenhum plano de exemplo foi inserido em contas reais.

## Achados remanescentes da revisão

O escopo desta rodada foi a paleta e as interfaces principais alteradas. A revisão também encontrou itens legados que precisam de uma etapa própria; não há alegação de conformidade total do aplicativo.

```text
index.html:2385 - placeholder do player usa div com clique; converter em controle nativo.
index.html:2579 - expansão do progresso do curso usa div com clique; implementar botão e estado expandido.
index.html:10446 - itens gerados da árvore de aulas usam div com clique; garantir operação por teclado.
index.html:10375 - falha do acervo expõe detalhes de configuração; trocar por mensagem orientada ao aluno e recuperação.
```

Filtros, paginação e seleção de conteúdo ainda não têm todo o estado refletido na URL. Legendas/transcrições dos materiais não foram verificadas. Esses itens são próximos passos de acessibilidade e continuidade de navegação, além desta aplicação de paleta.

## Entrega

Código na branch [`codex/premium-study-experience`](https://github.com/noroja/cuscuz/tree/codex/premium-study-experience). Sem merge ou publicação em produção.

Abertura automática de PR permanecia sem permissão na integração durante a etapa anterior. As alterações podem ser revisadas pela [comparação com main](https://github.com/noroja/cuscuz/compare/main...codex/premium-study-experience).
