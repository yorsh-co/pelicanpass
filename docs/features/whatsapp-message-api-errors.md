# Error codes

> https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes
>
> Copied from Meta's page on 2026-09-15. Meta's page is the source of truth; re-check a code there
> before acting on anything below.


The Cloud API is built on the Graph API, so if you are unfamiliar with handling Graph API error responses, see the [Graph API error handling](https://developers.facebook.com/docs/graph-api/guides/error-handling) documentation.

In general, Meta recommends that you build your app's error handling logic around `code` values and `details` payload properties. These properties and their values are more indicative of the underlying error.

Code titles, which do not have a dedicated property in API error response payloads, are included as part of the `message` value. However, Meta recommends that you do not rely on titles for your error handling logic as titles will eventually be deprecated.

**Warning:** **Receiving Errors: Synchronous and Asynchronous**

Cloud API errors are returned either synchronously as a Graph API response, asynchronously via Webhook, or sometimes through both methods.

It is a good practice when working with Cloud API that you monitor both the Graph API response and the `messages` webhook for error handling. If you are subscribed to the `messages` webhook field, you will receive notification of errors as they occur for supported asynchronous error types.

## Error response webhooks and syntax

Cloud API errors can be surfaced in the following webhook objects:

- `entry.changes.value.errors`
- `entry.changes.value.messages.errors`

**Error response syntax**

```html
{
  "error": {
    "message": "<MESSAGE>",
    "type": "<TYPE>",
    "code": <CODE>,
    "error_data": {
      "messaging_product": "whatsapp",
      "details": "<DETAILS>"
    },
    "error_subcode": <ERROR_SUBCODE>,
    "fbtrace_id": "<FBTRACE_ID>"
  }
}
```

## Error response contents

| Property | Value type | Description |
| --- | --- | --- |
| `code` | Integer | Error code. Build your app's error handling around error codes instead of subcodes or HTTP response status codes. |
| `details` | String | Error description and a description of the most likely reason for the error. May also contain information on how to address the error, such as which parameter is invalid or what values are acceptable. |
| `error_subcode` | Integer | **Deprecated. Will not be returned in v16.0+ responses.**<br><br>Graph API subcode. Not all responses will include a subcode, so build your error handling logic around `code` and `details` properties instead. |
| `fbtrace_id` | String | Trace ID you can include when contacting [Direct Support](https://business.facebook.com/direct-support). The ID may help debug the error. |
| `message` | String | Combination of the error code and its title. For example: `(#130429) Rate limit hit`. |
| `messaging_product` | String | Messaging product. This will always be the string `whatsapp` for Cloud API responses. |
| `type` | String | Error type. |

## Example response

```json
{
  "error": {
    "message": "(#130429) Rate limit hit",
    "type": "OAuthException",
    "code": 130429,
    "error_data": {
        "messaging_product": "whatsapp",
        "details": "Cloud API message throughput has been reached."
    },
    "error_subcode": 2494055,
    "fbtrace_id": "Az8or2yhqkZfEZ-_4Qn_Bam"
  }
}
```

## Authorization errors

| Code | `details` | Possible reasons and solutions |
| --- | --- | --- |
| `0` | `We were unable to authenticate the app user.` | Typically this means the included access token has expired, been invalidated, or the app user has changed a setting to prevent all apps from accessing their data. [Get a new access token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#system-user-access-tokens). |
| `3` | Capability or permissions issue. | Use the [access token debugger](https://developers.facebook.com/tools/debug/accesstoken) to verify that your app has been granted the permissions required by the endpoint. See [Authentication and Authorization Errors](https://developers.facebook.com/documentation/business-messaging/whatsapp/support#authentication-authorization). |
| `10` | Permission is either not granted or has been removed. | Use the [access token debugger](https://developers.facebook.com/tools/debug/accesstoken) to verify that your app has been granted the permissions required by the endpoint.<br><br>See [Authentication and Authorization Errors](https://developers.facebook.com/documentation/business-messaging/whatsapp/support#authentication-authorization).<br><br>For WhatsApp Flows with Endpoint - ensure that the phone number used to [set your business public key](https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/cloud-api/reference/whatsapp-business-encryption#set-business-public-key) is allowlisted.<br><br>Check the eligibility requirements for the API that you are trying to access. If you are not eligible to access the endpoints, you will receive this error code. |
| `190` | Your access token has expired. | Get a new [access token](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens). |
| `200` | No access token was provided. The API returns the message "Provide valid app ID". This error occurs on certain GET endpoints (such as `whatsapp_business_profile`) when no token is included. Other endpoints may return error code 190 or 104 instead. | Ensure your request includes a valid access token. This is distinct from error code 190 (expired or invalid token). See [Access Tokens](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens). |
| `200-299` | Permission is either not granted or has been removed. | Use the [access token debugger](https://developers.facebook.com/tools/debug/accesstoken) to verify that your app has been granted the permissions required by the endpoint. See [Authentication and Authorization Errors](https://developers.facebook.com/documentation/business-messaging/whatsapp/support#authentication-authorization). |

## Integrity errors

| Code | `details` | Possible reasons and solutions |
| --- | --- | --- |
| `368` | `The WhatsApp Business Account associated with the app has been restricted or disabled for violating a platform policy.` | See the [Policy Enforcement](https://developers.facebook.com/documentation/business-messaging/whatsapp/policy-enforcement) document to learn about policy violations and how to resolve them. |
| `130497` | `The WhatsApp Business Account is restricted from messaging to users in certain countries.` | See [WhatsApp Business Messaging Policy](https://business.whatsapp.com/policy) for details on allowed countries for messaging in your business category. |
| `131031` | `The WhatsApp Business Account associated with the app has been restricted or disabled for violating a platform policy, or we were unable to verify data included in the request against data set on the WhatsApp Business Account (e.g, the two-step pin included in the request is incorrect).` | See the [Policy Enforcement](https://developers.facebook.com/documentation/business-messaging/whatsapp/policy-enforcement) document to learn about policy violations and how to resolve them.<br><br>You can also use the [Health Status API](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/health-status), which may provide additional insight into the reason or reasons for the account lock. |

## Template creation errors

| Error | Description | Possible solution |
| --- | --- | --- |
| `2388039` - Message template status can't be changed | The status for this message template can't be changed. You can only delete or add templates. | This occurs when you try to edit a template whose status cannot be changed, for example, a template that is still in review. Wait until the template is approved or rejected before editing, and note that templates have a daily limit on the number of edits. |
| `2388040` - Character limit exceeded | A field in your template has exceeded the maximum character limit allowed. | Refer to the error message for specific details on the affected field and its corresponding character limits. |
| `2388047` - Message header format is incorrect | Your message header contains invalid formatting. | Refer to the error message for specific details on valid formatting. |
| `2388072` - Message body format is incorrect | Your message body contains invalid formatting. | Refer to the error message for specific details on valid formatting. |
| `2388073` - Message footer format is incorrect | Your message footer contains invalid formatting. | Refer to the error message for specific details on valid formatting. |
| `2388293` - Parameters words ratio exceeds limit | This template has too many variables for its length. Reduce the number of variables or increase the message length. | Refer to the error message for specific details on valid formatting. |
| `2388299` - Leading or trailing parameters not allowed | Variables cannot be at the start or end of the template. | Refer to the error message for specific details on valid formatting. |

## Send template errors

| Error | Description | Possible solution |
| --- | --- | --- |
| `2388019` - Message Template Limit Exceeded | `You have exceeded the maximum number of message templates you can have for this WhatsApp business account.` | A WhatsApp Business account can have up to 250 message templates. See [Template limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview#template-limits). |

## Phone migration errors

| Error | Description | Possible Solution |
| --- | --- | --- |
| `2388012` - This phone number already exists in your list of phone numbers. | The phone number you are trying to migrate is already present in your WhatsApp account. | Try again with a phone number that is not already present in your WhatsApp account. |
| `2388091`, `2388093` - This phone number isn’t eligible to receive/verify a registration code since it is not being migrated. | Phone ownership verification APIs are not available for this use case. | [Register and verify the number](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/registering-phone-numbers). |
| `2388103` - Cannot migrate phone number. | Webhooks have not been set up for the destination WhatsApp Business account. | [Subscribe your app to webhooks](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview) on the destination WhatsApp Business account. |
| `2388103` - Please add this phone number in your WhatsApp account | This phone number is eligible to be added directly, and does not need to use phone migration APIs. | [Register and verify the number](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/registering-phone-numbers). |
| `2388103` - Registered name should be present and approved. | The business phone number must have an approved display name (`name_status` is `APPROVED`) and cannot have any associated pending display name change requests. | Get your business phone number's [display name approved](https://developers.facebook.com/documentation/business-messaging/whatsapp/display-names). |
| `2388103` - The WhatsApp account that this phone number is registered with is not set up correctly. | The source WhatsApp Business Account must be approved, and its "messaging on behalf of" must be approved. | The WhatsApp Business Account may be using the [now deprecated On-Behalf-Of ownership model](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/obo-model-deprecation).<br><br>Contact support. |
| `2388103` - Your WhatsApp account does not have a payment account. | Your WhatsApp account must have an active credit line in order to send messages after migration. | [Set up a credit line](https://www.facebook.com/business/help/1684730811624773) and [share it with the business customer](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/share-and-revoke-credit-lines). |
| `2388103` - There was an error migrating this phone number. | Something went wrong when trying to migrate your phone number. | Try again after some time. If that doesn’t work, [contact support](https://developers.facebook.com/documentation/business-messaging/whatsapp/support). |
| `2388103` - This phone number belongs to a different Business Manager account. | The source and destination WABAs must represent the same business. | [Migrate the phone number](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/support/migrating-phone-numbers-among-solution-partners-programmatically) into a WhatsApp Business Account that is messaging for the same business as the source WhatsApp Business Account. |
| `2388103` - Your WhatsApp account must be approved | The destination WhatsApp Business Account must be approved before you can migrate phone numbers. | Ensure [business verification](https://www.facebook.com/business/help/2058515294227817) is completed, and the WhatsApp Business Account review status is approved. |
| `2388103` - Your WhatsApp account’s "Messaging For" request must be approved | The destination WhatsApp Business Account "Messaging For" request must be approved by the client. | Ask your client to accept your "Messaging For" request in the Meta Business Suite. |
| `2494100` - Account is in maintenance mode. | The business phone number is in maintenance mode. | Try again in a few minutes. |

## Template insights errors

| Error | Description | Possible solution |
| --- | --- | --- |
| `200005` - Template insights unavailable | Template insights are not available yet for this WhatsApp Business account. | You are unable to enable template insights for this WhatsApp Business account at the moment. |
| `200006` - Cannot disable template insights | Invalid operation. Template Insights cannot be disabled once enabled. | Template insights cannot be disabled once enabled for a WhatsApp Business account. |
| `200007` - Template Insights not enabled | `Template Insights have not been enabled for this WhatsApp Business Account` | To enable template insights, see [Confirming template analytics](https://developers.facebook.com/documentation/business-messaging/whatsapp/analytics#confirming-template-analytics). |

## Synchronization errors

| Code | `details` | Possible reasons and solutions |
| --- | --- | --- |
| `2593107` | `You have exceeded the maximum number of times to call the synchronization api for this phone number.` | You can only call this endpoint once to synchronize the business phone number contacts and once to synchronize its messaging history. See [Onboarding business app users](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users#synchronizing-whatsapp-business-app-data).<br><br>Offboard the business customer and re-onboard them. |
| `2593108` | Synchronization request can only be made within 24 hours of onboarding | You can only initiate contacts and messaging history synchronization of an onboarded WhatsApp Business app user within 24 hours of onboarding the user. See [Onboarding business app users](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users#synchronizing-whatsapp-business-app-data).<br><br>Offboard the user and re-onboard them. |

## Throttling errors

| Code | `details` | Possible reasons and solutions |
| --- | --- | --- |
| `4` | The app has reached its API call rate limit. | Load the app in the [App Dashboard](https://developers.facebook.com/apps) and view the **Application Rate Limit** section to verify that the app has reached its [rate limit](https://developers.facebook.com/docs/graph-api/overview/rate-limiting#wa-biz-api). If it has, try again later or reduce the frequency or amount of API queries the app is making. |
| `80007` | `The WhatsApp Business Account has reached its rate limit.` | See WhatsApp Business account [Rate Limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/about-the-platform#rate-limits). Try again later or reduce the frequency or amount of API queries the app is making. |
| `130429` | Cloud API message throughput has been reached. | The app has reached the API's throughput limit. See [Throughput](https://developers.facebook.com/documentation/business-messaging/whatsapp/throughput). Try again later or reduce the frequency with which the app sends messages. |
| `131048` | Message failed to send because there are restrictions on how many messages can be sent from this phone number. This may be because too many previous messages were blocked or flagged as spam. | Check your quality status in the WhatsApp Manager. See [Template limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview#template-limits) and [Template quality](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-quality). |
| `131056` | Too many messages sent from the sender phone number to the same recipient phone number in a short period of time. | Wait and retry the operation, if you intend to send messages to the same phone number. You can still send messages to a different phone number without waiting. |
| `133016` | `Registration or Deregistration failed because there were too many attempts for this phone number in a short period of time` | The business phone number is being blocked because it has reached its registration/deregistration attempt limit. Try again once the number is unblocked. See "Limitations" in the [Registration](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/registration) document. |
| `131064` | Message failed to send because this account has reached its messaging limit due to template classification violations. This applies to both template messages and direct send messages. | Review your template classifications and ensure they are categorized correctly. This restriction is automatically lifted after the enforcement period. See [Template quality](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-quality) for more information. |

## Other errors

| Code | `details` | Possible reasons and solutions |
| --- | --- | --- |
| `1` | Invalid request or possible server error. | Check the [WhatsApp Business Platform Status](https://metastatus.com/whatsapp-business-api) page to see API status information. If there are no server outages, check the endpoint reference and verify that your request is formatted correctly and meets all endpoint requirements. |
| `2` | Temporary due to downtime or due to being overloaded. | Check the [WhatsApp Business Platform Status](https://metastatus.com/whatsapp-business-api) page to see API status information before trying again. |
| `33` | The business phone number has been deleted. | Verify that the business phone number is correct. |
| `100` | The request included one or more unsupported or misspelled parameters. | See the endpoint's reference to determine which parameters are supported and how they are spelled.<br><br>For WhatsApp Flows with Endpoint - ensure when setting your business public key, it is a [valid 2048-bit RSA public key in PEM format](https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/cloud-api/reference/whatsapp-business-encryption#gen).<br><br>Ensure there is no mismatch between the phone number ID you are [registering](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/registering-phone-numbers) and a previously stored phone number id.<br><br>Ensure your parameter is under any length restriction for the type. |
| `130403` | Unable to deliver the message. This business has blocked the end user on WhatsApp | Do not retry. Unblock the WhatsApp user to resume sending messages to them. See [Unblock a user](https://developers.facebook.com/documentation/business-messaging/whatsapp/block-users/#unblock-a-user). |
| `130472` | Message was not sent as part of an [experiment](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/experiments). | See [Marketing Message Experiment](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/experiments#marketing-message-experiment). |
| `131000` | Message failed to send due to an unknown error. | Try again. If the error persists, open a [Direct Support](https://business.facebook.com/direct-support) ticket.<br><br>For WhatsApp Flows with Endpoint - when [setting a business public key](https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/cloud-api/reference/whatsapp-business-encryption#set-business-public-key), it either failed to calculate the signature, call the GraphQL endpoint, or the GraphQL endpoint returned an error. |
| `131005` | Permission is either not granted or has been removed. | Use the [access token debugger](https://developers.facebook.com/tools/debug/accesstoken) to verify that your app has been granted the permissions required by the endpoint. See [Authentication and authorization errors](https://developers.facebook.com/documentation/business-messaging/whatsapp/support#authentication-authorization). |
| `131008` | The request is missing a required parameter. | See the endpoint's reference to determine which parameters are required. |
| `131009` | One or more parameter values are invalid. | See the endpoint's reference to determine which values are supported for each parameter, and see [Phone Numbers](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers) to learn how to add a phone number to a WhatsApp Business account. |
| `131016` | A service is temporarily unavailable. | Check the [WhatsApp Business Platform Status](https://metastatus.com/whatsapp-business-api) page to see API status information before trying again. |
| `131021` | Sender and recipient phone number is the same. | Send a message to a phone number different from the sender. |
| `131026` | Unable to deliver message. Reasons can include:<br><br>* The recipient phone number is not a WhatsApp phone number.<br>* Recipient has not accepted the new Terms of Service and Privacy Policy.<br>* Recipient using an old WhatsApp version; must use the following WhatsApp version or greater:<br>  * Android: 2.21.15.15<br>  * SMBA: 2.21.15.15<br>  * iOS: 2.21.170.4<br>  * SMBI: 2.21.170.4<br>  * KaiOS: 2.2130.10<br>  * Web: 2.2132.6 | Using a non-WhatsApp communication method, ask the WhatsApp user to:<br><br>* Confirm that they can actually send a message to your WhatsApp Business phone number.<br>* Confirm that they have accepted the latest Terms of Service (**Settings** > **Help**, or **Settings** > **Application information** will prompt them to accept the latest terms/policies if they haven't done so already)<br>* Update to the latest version of the WhatsApp client. |
| `131037` | The [555 business phone number](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview#555-business-phone-numbers) used to send the request does not have an approved [display name](https://developers.facebook.com/documentation/business-messaging/whatsapp/display-names). | Change the 555 business phone number's [display name](https://developers.facebook.com/documentation/business-messaging/whatsapp/display-names). Also see our [How to change your WhatsApp Business display name](https://www.facebook.com/business/help/378834799515077) Help Center article. |
| `131042` | There was an error related to your payment method. | See [About Billing For Your WhatsApp Business account](https://www.facebook.com/business/help/2225184664363779) and verify that you have set up billing correctly.<br><br>Common problems:<br><br>- Payment account is not attached to a WhatsApp Business account<br>- Credit line is over the limit<br>- Credit line (Payment Account) not set or active<br>- WhatsApp Business account is deleted<br>- WhatsApp Business account is suspended<br>- Timezone not set<br>- Currency not set<br>- MessagingFor request (On Behalf Of) is pending or declined |
| `131045` | Message failed to send due to a phone number registration error. | [Register the phone number](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/registration) before trying again. |
| `131047` | More than 24 hours have passed since the recipient last replied to the sender number. | Send the recipient a [template message](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview) instead. |
| `131049` | This message was not delivered to maintain healthy ecosystem engagement. | If you do receive this error code and suspect it is due to the limit, wait at least 24 hours before resending the template message. Doing so will only result in another error response since the limit may be in effect for differing periods of time.<br><br>See [Per-User Marketing Template Message Limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/marketing-templates/per-user-limits) for additional information. |
| `131050` | Unable to deliver the message. This recipient has chosen to stop receiving marketing messages on WhatsApp from your business. | Do not retry sending messages to this user as they will not be received. To be notified whenever a WhatsApp user stops or resumes delivery of marketing template messages from your business, subscribe to the [user_preferences webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/user_preferences). |
| `131051` | Unsupported message type. | See [Messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages#message-types) for supported message types before trying again with a supported message type. |
| `131052` | Unable to download the media sent by the user. | The media included in the WhatsApp user's message could not be downloaded. For more information, refer to the `error.error_data.details` value in any **messages** webhooks triggered when this message was received.<br><br>Ask the WhatsApp user to send you the media file using a non-WhatsApp method. |
| `131053` | Unable to upload the media used in the message. | The media could not be uploaded for one or more reasons, such as an unsupported media type.<br><br>For more information, refer to the `error.error_data.details` value in any **messages** webhooks triggered when this message fails to send.<br><br>Inspect any media files that are causing errors and confirm that they are in fact supported. For example, in UNIX you can use file inspection via the command line to determine its MIME type:<br><br>`file -I rejected-file.mov`<br><br>You can then confirm if its MIME type is supported. See [Supported Media Types](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media#supported-media-types). |
| `131057` | Business Account is in maintenance mode | The WhatsApp Business account is in maintenance mode. One reason for this could be that the account is undergoing a [throughput](https://developers.facebook.com/documentation/business-messaging/whatsapp/throughput) upgrade. |
| `131063` | Your template is categorized as Marketing, but marketing templates are currently disabled for your Cloud API configuration. | The business has set `disable_marketing_messages_on_cloud_api` to `true` on their WhatsApp Business account. To send this template, use the [Marketing Messages API](https://developers.facebook.com/documentation/business-messaging/whatsapp/marketing-messages/send-marketing-messages), or [re-enable marketing templates on Cloud API](https://developers.facebook.com/documentation/business-messaging/whatsapp/marketing-messages/send-marketing-messages#re-enable-marketing-messages-on-cloud-api) by setting `disable_marketing_messages_on_cloud_api` to `false`. |
| `132000` | The number of variable parameter values included in the request did not match the number of variable parameters defined in the template. | See our [Templates](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview#parameter-formats) document to learn about parameters and make sure the request includes values for all of the parameters required by the template. |
| `132001` | The template does not exist in the specified language or the template has not been approved. | Make sure your template has been approved and the template name and language locale are correct. See our [Templates](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview) document to learn more about templates. |
| `132005` | Translated text is too long. | Check the WhatsApp Manager to verify that your template has been translated. See our [Template quality](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-quality) document to learn how to check the status of your template. |
| `132007` | Template content violates a WhatsApp policy. | See our [Template review](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-review) document to learn about possible reasons for the violation. |
| `132012` | Variable parameter values formatted incorrectly. | The variable parameter values included in the request are not using the format specified in the template. See our [Templates](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview#parameter-formats) document to learn more about template parameters and formats. |
| `132015` | Template is paused due to [low quality](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-quality) so it cannot be sent in a template message. | [Edit the template](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-management#edit-templates) to improve its quality and try again once it is approved. |
| `132016` | Template has been paused too many times due to [low quality](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-quality) and is now permanently disabled. | Create a new template with different content. |
| `132068` | Flow is in blocked state. | Correct the Flow |
| `132069` | Flow is in throttled state and 10 messages using this flow were already sent in the last hour. | Correct the Flow |
| `133000` | A previous deregistration attempt failed. | [Deregister](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/registration#deregister-phone) the number again before [registering](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/registration). |
| `133004` | Server is temporarily unavailable. | Check the [WhatsApp Business Platform Status](https://metastatus.com/whatsapp-business-api) page to see API status information and check the response `details` value before trying again. |
| `133005` | Two-step verification PIN incorrect. | Verify that the two-step verification PIN included in the request is correct.<br><br>To reset the PIN, disable two-step verification, then set a new PIN. See [Two-step verification](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers#two-step-verification). |
| `133006` | Phone number needs to be verified before registering. | [Verify and register the phone number](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/registering-phone-numbers). |
| `133008` | Too many two-step verification PIN guesses for this phone number. | Try again after the amount of time specified in the `details` response value. |
| `133009` | Two-step verification PIN was entered too quickly. | Check the `details` response value before trying again. |
| `133010` | Phone number not registered on the WhatsApp Business Platform. | [Register the phone number](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/registration) before trying again. |
| `133015` | The phone number you are attempting to register was recently deleted, and deletion has not yet completed. | Wait 5 minutes before re-trying the request. |
| `134011` | `Message failed to send because WhatsApp Payments terms of service acceptance is pending for this WhatsApp Business Account.` | Accept the WhatsApp Payments terms of service using the link provided in the error message before trying again. |
| `135000` | Message failed to send because of an unknown error with your request parameters. | See the endpoint's [reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/overview) to determine if you are querying the endpoint using the correct syntax.  Contact [customer support](https://developers.facebook.com/support/) if you continue receiving this error code in response. |

## Marketing Messages API for WhatsApp error codes

MM API for WhatsApp uses the same error codes as Cloud API, with a few additions listed below.

### Example

```json
{
  "error": {
    "message": "(#100) Invalid parameter",
    "type": "OAuthException",
    "code": 100,
    "error_data": {
      "messaging_product": "whatsapp",
      "details": "Message must be a template message."
    },
    "fbtrace_id": "Ak6nxJSySLEJz32Ps-QiZ1t"
  }
}
```

### Codes

| Code | Message | Details | Possible reasons and solutions | HTTP<br><br>status<br> code |
| --- | --- | --- | --- | --- |
| `100` | `(#100) Invalid parameter` | `Message must be a template message.` | You are attempting to send a non-template message. Message type must be `template`. Try again using a marketing template. | 400 Bad Request |
| `131009` | `(#131009) Parameter value is not valid` | `One or more parameter values are invalid.` | You may be using an invalid parameter. Verify that you are using a [valid parameter](https://developers.facebook.com/documentation/business-messaging/whatsapp/marketing-messages/send-marketing-messages) and try again.<br><br>Ad syncing may be incomplete. Wait 10 minutes and try again. If the issue persists, contact support. | 400 Bad Request |
| `131055` | `(#131055) Method not allowed` | `Only marketing template messages are supported` | You may have attempted to send a non-template message, or an authentication or utility template. Try sending again using a marketing template message. | 400 Bad Request |
| `134100` | `(#134100) Only marketing messages supported` | `You're only able to send marketing messages on this API.` | _Will be available with Graph API version 23.0._<br><br>You are attempting to send a utility or authentication template. Only templates categorized as `MARKETING` are supported. | 400 Bad Request |
| `134101` | `(#134101) Your template is still syncing` | `When you send a message from a template, the template syncing process can take up to 10 minutes to complete. Wait a few minutes, and then try sending your message again.` | _Will be available with Graph API version 23.0._<br><br>You are attempting to send a newly created template before it has completed Ad synchronization. Ad synchronization can take up to 10 minutes. Wait 10 minutes and try again. | 400 Bad Request |
| `134102` | `(#134102) Template unavailable for use` | `Please check your eligibility status to ensure you are onboarded or contact Meta's customer support.` | _Will be available with Graph API version 23.0._<br><br>Ad synchronization could not be completed for the template you are attempting to send, or you may not be eligible for MM API for WhatsApp.<br><br>[Check your eligibility status](https://developers.facebook.com/documentation/business-messaging/whatsapp/marketing-messages/onboarding#check-waba-onboarding-status-and-eligibility). If the WhatsApp Business account's `marketing_messages_lite_api_status` value is `ONBOARDED`, and the problem persists, please [contact support](https://business.facebook.com/direct-support/). | 500 Internal Server Error |
| `132018` | `(#132018) Template validation error` | `There's an issue with the parameters in your template.` | Review the errors, update the parameters as needed, and resend your message using a correctly configured template. | 400 Bad Request |
| `1752041` | `(#1752041) Duplicate Request` | `Duplicate Request is thrown when a client has already been invited to onboard by any partner.` | Onboarding requests are limited to one per business customer, with only the first partner to call the intent API able to successfully submit the request. When a client is onboarded, all of their eligible WhatsApp Business accounts (WABAs) are included in the process automatically.<br><br>If you receive an error indicating that the onboarding request has already been made, no further action is required, as all eligible WABAs for that client will be onboarded without additional steps. | 400 Bad Request |
