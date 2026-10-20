<!--
  Wording can change at any time. Do not change a question's `id` or `type` after the survey
  has opened. Rules: docs/features/survey.md § The questions files.
-->

# Questionário de voluntário

Queremos saber o que você achou!

## Como você avalia sua experiência geral servindo em {eventName}?

- id: overall_rating
- type: rating
- required: yes

1: ruim. 10: excelente.

## Como você avalia a preparação antes do evento (orientações, reuniões, treinamento)?

- id: preparation_rating
- type: rating
- required: yes

## Como você avalia a comunicação com a coordenação durante o evento?

- id: coordination_rating
- type: rating
- required: yes

## Como você avalia o aplicativo como ferramenta de trabalho?

- id: app_rating
- type: rating
- required: yes

## Você serviria de novo em outra edição?

- id: would_serve_again
- type: yes-no
- required: yes

## Deixe aqui seus comentários, elogios, críticas ou sugestões para a próxima edição.

- id: comments
- type: text
- required: no
- max-length: 500
