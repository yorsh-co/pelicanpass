<!--
  Wording can change at any time. Do not change a question's `id` or `type` after the survey
  has opened. Rules: docs/features/survey.md § The questions files.
-->

# Questionário de experiência

Queremos saber o que você achou!

## Que nota você dá para {eventName}?

- id: overall_rating
- type: rating
- required: yes

1: ruim. 10: excelente.

## O que você achou da programação?

- id: programme_rating
- type: rating
- required: yes

## O que você achou do check-in na entrada?

- id: checkin_rating
- type: rating
- required: yes

## O que você achou da alimentação?

- id: food_rating
- type: rating
- required: yes

## O que você achou do local e da estrutura?

- id: venue_rating
- type: rating
- required: yes

## O que você achou da comunicação antes do evento?

- id: communication_rating
- type: rating
- required: yes

## Se você deu nota 7 ou menos para algum item, conta pra gente o porquê.

- id: low_rating_reason
- type: text
- required: no
- max-length: 500

## Você voltaria em outra edição de {eventName}?

- id: would_return
- type: yes-no
- required: yes

## Você recomendaria {eventName} para um amigo?

- id: would_recommend
- type: yes-no
- required: yes

## Deixe aqui seus comentários, elogios e sugestões para a próxima edição.

- id: comments
- type: text
- required: no
- max-length: 800
