<!--
  Wording can change at any time. Do not change a question's `id` or `type` after the survey
  has opened. Rules: docs/features/survey.md § The questions files.
-->

# Volunteer survey

We want to know what you thought!

## How would you rate your overall experience serving at {eventName}?

- id: overall_rating
- type: rating
- required: yes

1: poor. 10: excellent.

## How would you rate the preparation before the event (briefings, meetings, training)?

- id: preparation_rating
- type: rating
- required: yes

## How would you rate the communication with the coordinators during the event?

- id: coordination_rating
- type: rating
- required: yes

## How would you rate the app as a tool for your work?

- id: app_rating
- type: rating
- required: yes

## Would you serve again at another edition?

- id: would_serve_again
- type: yes-no
- required: yes

## Leave your comments, compliments, criticism or suggestions for the next edition here.

- id: comments
- type: text
- required: no
- max-length: 500
