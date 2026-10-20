# Como cuidamos dos seus dados no aplicativo {eventName}

> **Modelo:** deve ser revisado e substituído pelo operador antes da implantação.

Este aviso explica quais dados o aplicativo usa, para quê, por quanto
tempo e o que você pode pedir a qualquer momento.

## Quem cuida dos seus dados

**[RAZÃO SOCIAL]**, CNPJ [CNPJ], na condição de controladora de dados.

Este aplicativo foi desenvolvido para um evento do organizador e segue a
Política de Privacidade e Proteção de Dados de [RAZÃO SOCIAL], publicada em
[SITE]. O aviso abaixo trata exclusivamente do evento {eventName}.

## Quais dados o aplicativo usa

De cada pessoa inscrita, apenas três dados pessoais:

- **Primeiro nome e sobrenome** — informados pelo responsável na sua inscrição no
  evento.
- **Número de telefone** — informado na mesma inscrição.
- **Apelido** — você mesmo pode digitar depois do check-in, se
  quiser mudar como seu nome aparece na sua tela.

Se você é **voluntário**, o aplicativo usa também **informações sobre o seu
serviço** no evento, como equipe, função e horários, definidas pela
coordenação de voluntários. Elas **não entram no relatório final**.

Além desses, o aplicativo registra informações que não identificam você sozinhas:
o **código, o número e o horário do seu check-in** e as suas escolhas de
**lanche, bebida e camiseta**.

Quando você retira um desses itens, o aplicativo também registra **o horário da
retirada** e **qual voluntário atendeu você**. Se a retirada não for possível —
porque o item já tinha sido retirado, ou porque não estava na sua inscrição — a
tentativa também fica registrada. Isso serve para conferir as entregas e
identificar o uso indevido de ingressos, e nada mais. Esse registro é destruído
junto com o servidor e **não entra no relatório final**.

> Sua data de nascimento, documento, endereço, e-mail, foto ou qualquer outro
> dado pessoal **nunca são processados por este aplicativo.**

## Para que serve cada dado que processamos

- **Confirmar que a pessoa certa entrou** — o código do ingresso identifica sua
  inscrição, o nome permite que você confirme na tela que o cadastro é seu, e os
  quatro últimos dígitos do telefone são o código que conclui o check-in. É o que
  impede alguém de usar o seu ingresso. Voluntários do evento também podem
  conferir o nome na porta.
- **Ajudar você na porta** — voluntários autorizados podem ver o seu telefone,
  para corrigir um número digitado errado ou para ajudar você a concluir o
  check-in se não lembrar com qual número se inscreveu.
- **Informar sobre o evento** — o telefone é o canal por onde chega o link de
  check-in e os avisos do evento.
- **Personalizar sua experiência** — o apelido muda como seu nome aparece para
  você dentro do aplicativo.
- **Orientar os voluntários** — as informações sobre o serviço dizem ao
  voluntário onde e quando vai servir, no passe e nas mensagens de WhatsApp.

> **Zero marketing**, **zero rastreamento** e **zero reaproveitamento**: o
> aplicativo não tem propaganda, não usa pixel rastreador, e seus dados não são
> vendidos, cruzados com outras bases nem usados para nada fora do evento.

## Se você tem menos de 18 anos

Seu nome e seu telefone foram fornecidos pelo **seu responsável legal** no momento
da inscrição no evento, feita no sistema de inscrição. É dele o consentimento que
autoriza este tratamento.

Os dados do responsável **não entram** neste aplicativo — a não ser que ele tenha
optado por informar o próprio telefone no lugar do seu.

Se a inscrição for feita na hora, no dia do evento, esses mesmos dados são
coletados no momento da inscrição e passam pelo aplicativo da mesma forma.

Dentro do aplicativo, seu identificador principal é o código de seis caracteres
do seu ingresso e um número aleatório gerado pelo banco de dados, e não o seu
nome.

## Onde os dados ficam

O armazenamento é 100% local, num servidor do organizador.

- **Banco de dados local** — fica num servidor local, em rede fechada, sem
  qualquer acesso aberto à internet. É destruído depois do evento.
- **Cache temporário** — durante o check-in, guarda o código do ingresso, o nome
  e os primeiros dígitos do telefone, para você confirmar que o cadastro é seu;
  isso se apaga sozinho em até 15 minutos. Depois do check-in, guarda apenas um
  identificador aleatório do seu cadastro, para você não repetir o processo a
  cada tela, e se apaga sozinho após 24 horas.
- **Registros de operação** — anotam o horário, a rota e o código de resposta de
  cada acesso, junto com o endereço de rede (IP), o tipo de navegador ou aparelho
  e o país de onde veio o acesso. Servem para acompanhar o desempenho do
  aplicativo e identificar abusos, e nada mais: não alimentam análise de
  comportamento nem perfil de ninguém. Erros do aplicativo, inclusive os que
  acontecem no seu navegador, são registrados da mesma forma. **Não registram
  nome, apelido nem telefone.** São destruídos junto com o servidor.

## As plataformas que serão utilizadas

Três, e só o necessário para o evento funcionar:

- **Cloudflare** — cuida da conexão e protege o aplicativo contra ataques. Recebe
  o endereço de rede (IP) e dados técnicos de conexão. Para proteger o
  aplicativo, as telas **passam pela Cloudflare** a caminho do seu aparelho, mas
  ela não guarda nem usa esse conteúdo para nada além de entregá-lo. Na tela de
  check-in, a Cloudflare também faz uma verificação automática para distinguir
  pessoas de robôs. Para voluntários, o e-mail usado para entrar no painel de
  administração fica na lista de acesso da Cloudflare, junto com o registro de
  quando cada um entrou.
- **WhatsApp (Meta)** — utilizado para enviar as informações de check-in. Recebe
  seu **número de telefone**, seu **primeiro nome**, o **código do seu ingresso**
  e o **link do seu ingresso**. Se você é **voluntário**, recebe também
  **informações sobre o seu serviço** no evento, como equipe e horários.
  Nada além disso. A Meta informa ao aplicativo se a mensagem foi entregue e
  lida, e isso fica registrado. Respostas enviadas a esse número não são lidas
  nem guardadas. A Meta apaga os dados de mensagens e usuários após
  [30 dias](https://developers.facebook.com/documentation/business-messaging/whatsapp/data-privacy-and-security/#store-collected-data).
- **Tailscale** — cria a rede privada (VPN) que serve de caminho reserva para os
  voluntários do evento acessarem o painel de administração. Recebe apenas
  dados técnicos de conexão dos aparelhos ligados a essa rede: nome do aparelho,
  sistema operacional, endereço de rede (IP), chave pública e horários de
  acesso. Os dados de participante que aparecem no painel — nome, código do
  ingresso e telefone — passam por essa conexão **criptografados de ponta a
  ponta**, entre o servidor do organizador e o aparelho do voluntário, e a Tailscale
  **não tem como lê-los**.

> A Cloudflare e a Meta são empresas dos Estados Unidos, certificadas no **Data
> Privacy Framework**. A Tailscale é uma empresa do Canadá, e o contrato dela
> adota as **cláusulas contratuais padrão da Comissão Europeia** (GDPR).

## Cookies e preferências no navegador

O aplicativo usa **cookies de sessão**, inacessíveis aos scripts da página e
apagados quando você fecha o navegador. São eles que mantêm você conectado durante
o check-in e depois dele, para não repetir o processo a cada tela. Como são
necessários para o aplicativo funcionar, as telas do aplicativo exibem um aviso
simples.

A **Cloudflare** também grava cookies próprios no seu navegador, para distinguir
pessoas de robôs e proteger o aplicativo contra ataques. Eles não identificam você
e não são lidos pelo aplicativo.

O aplicativo também guarda **preferências de uso**, como o tema claro ou escuro
que você escolhe no botão da tela e o idioma das telas. O tema fica só no seu
próprio aparelho e não é enviado para o servidor. O idioma fica em um cookie
chamado **locale**, enviado ao servidor para que as telas venham no idioma
escolhido; ele contém apenas o código do idioma (por exemplo, `pt-BR`) e dura um
ano. Nenhuma dessas preferências identifica você ou é usada para rastreamento, e
todas somem quando você limpa os dados do navegador.

> Não há pixel de rede social, ferramenta de análise de comportamento (além da
> própria Cloudflare) nem rastreador de qualquer tipo.

## Por quanto tempo ficam guardados

- **Durante o evento** — você usa o aplicativo para retirar a camiseta, pegar
  o lanche, ver informações do evento e responder ao formulário de feedback. O
  único dado pessoal que circula nessas telas é o primeiro nome e, no ingresso de um
  voluntário, as informações sobre o seu serviço.
- **Depois do evento** — o formulário de feedback continua disponível, no mesmo aparelho em
  que você fez o check-in, até o horário de encerramento anunciado pela organização.
- **Até 24 horas depois** — o servidor é desligado e o banco de dados é destruído
  junto com ele. Qualquer cópia de segurança feita antes ou durante o evento
  é destruída junto.

Quando você responde ao formulário, o aplicativo guarda apenas a informação de que você já
respondeu, para que ele não seja enviado duas vezes. Esse registro é apagado antes do relatório
final e nunca é ligado às suas respostas.

Sobrevivem apenas dois arquivos: um **relatório de participação pseudonimizado** e
as **respostas anonimizadas do formulário de feedback**, sem nome, ingresso, telefone nem
horário que liguem uma resposta a quem respondeu.

> O relatório guarda o código do ingresso, para o caso de ser preciso conferir um
> check-in usando como referência os dados do sistema de inscrição do evento. Junto dele
> ficam se você é participante ou voluntário, o número e o horário do seu
> check-in, os itens da sua inscrição, se e quando você retirou cada um, e se a
> inscrição foi cancelada. **Nome, apelido, telefone e as informações sobre o
> serviço de voluntário não constam no relatório**, e o registro de qual
> voluntário atendeu você também não.

## Seus direitos

A qualquer momento, você ou seu responsável podem pedir para:

- saber se tratamos dados seus, e quais são;
- corrigir algo que esteja errado;
- apagar seus dados da nossa base.

> Informações importantes: se você solicitar a remoção dos seus dados **antes** do
> evento, não será possível fazer o check-in pelo aplicativo, e a entrada terá de
> ser feita manualmente na porta. E **depois** que o servidor é desligado não há
> mais base para apagar — os dados já foram destruídos.

## Como falar com a gente

O canal oficial de dúvidas e solicitações é o encarregado de dados de
[RAZÃO SOCIAL]: [CONTATO]. O aplicativo não cria nenhum canal paralelo.

---

Documento completo: Política de Privacidade e Proteção de Dados de
[RAZÃO SOCIAL], publicada em [SITE].

Aviso atualizado em outubro de 2026.
