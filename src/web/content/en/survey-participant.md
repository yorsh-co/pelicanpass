<!--
  Wording can change at any time. Do not change a question's `id` or `type` after the survey
  has opened. Rules: docs/features/survey.md § The questions files.
-->

# Experience survey

We want to know what you thought!

## How would you rate {eventName}?

- id: overall_rating
- type: rating
- required: yes

1: poor. 10: excellent.

## What did you think of the schedule?

- id: programme_rating
- type: rating
- required: yes

## What did you think of the check-in at the entrance?

- id: checkin_rating
- type: rating
- required: yes

## What did you think of the food?

- id: food_rating
- type: rating
- required: yes

## What did you think of the venue and facilities?

- id: venue_rating
- type: rating
- required: yes

## What did you think of the communication before the event?

- id: communication_rating
- type: rating
- required: yes

## If you rated any item 7 or lower, tell us why.

- id: low_rating_reason
- type: text
- required: no
- max-length: 500

## Would you come back for another edition of {eventName}?

- id: would_return
- type: yes-no
- required: yes

## Would you recommend {eventName} to a friend?

- id: would_recommend
- type: yes-no
- required: yes

## Leave your comments, compliments and suggestions for the next edition here.

- id: comments
- type: text
- required: no
- max-length: 800
