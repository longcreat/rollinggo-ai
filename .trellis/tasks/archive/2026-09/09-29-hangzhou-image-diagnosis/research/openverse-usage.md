![Image 1: logo](https://raw.githubusercontent.com/WordPress/openverse/HEAD/documentation/meta/brand/logo.svg)

*   auth 
    *   post register 
    *   post token 
    *   get key_info 

*   audio 
    *   get audio_search 
    *   get audio_detail 
    *   get audio_related 
    *   post audio_report 
    *   get audio_thumb 
    *   get audio_waveform 
    *   get audio_stats 
    *   get images_thumb 

*   images 
    *   get images_search 
    *   get images_detail 
    *   get images_related 
    *   post images_report 
    *   get images_oembed 
    *   get images_stats 

[![Image 2: redocly logo](https://cdn.redoc.ly/redoc/logo-mini.svg)API docs by Redocly](https://redocly.com/redoc/)

# Openverse API (909aa41ddf2115a69a447198b3f49121481e0c6b (v1))

Download OpenAPI specification:[Download](https://api.openverse.org/v1/schema/)

Openverse: [openverse@wordpress.org](mailto:openverse@wordpress.org)License: [MIT License](https://github.com/WordPress/openverse/blob/main/LICENSE)[Terms of Service](https://docs.openverse.org/terms_of_service.html)

Openverse is a search engine for openly-licensed media. The Openverse API is a system that allows programmatic access to public domain digital media. It is our ambition to index and catalog billions of openly-licensed works, including articles, songs, videos, photographs, paintings, and more.

Using this API, developers will be able to access the digital commons in their own applications. You can see some examples of [apps built with Openverse](https://docs.openverse.org/api/reference/made_with_ov.html) in our docs.

[Openverse documentation](http://docs.openverse.org/api/user/index.html)

## [](https://api.openverse.org/v1/#tag/auth)auth

Openverse provides free and open access to the Openverse API to anonymous and registered users. [Refer to the API documentation site for information on how to register](https://api.openverse.org/v1/#tag/auth).

All Openverse API users are subject to rate limits and restrictions on how much of Openverse's dataset can be accessed through the API. [Individuals should contact Openverse to request expanded access to the API](https://github.com/WordPress/openverse#keep-in-touch). Requests are considered on a case-by-case basis and are subject to evaluation in light of [Openverse's Terms of Service](https://docs.openverse.org/terms_of_service.html). Escalated access may be revoked at any time.

To authenticate yourself, you must sign up for an API key using the `register` endpoint and then get an access token using the `token` endpoint. Read on to know about these endpoints.

In subsequent requests, include your access token as a bearer token in the `Authorization` header.

```
Authorization: Bearer <access_token>
```

### Rate limits

Openverse endpoints are rate limited. Anonymous requests should be sufficient for most users. Indeed, [https://openverse.org](https://openverse.org/) itself operates using anonymous requests from the browser.

Registered users are automatically granted slightly higher limits. Further increases to rate limits are available upon request (see above).

Every Openverse API response that was subject to rate-limits includes headers outlining the permitted and available usage. Exceeding the limit will result in '429: Too Many Requests' responses.

### Pagination

Openverse's dataset is valuable, and the [Terms of Service](https://docs.openverse.org/terms_of_service.html) disallow scraping under all circumstances. As such, pagination for anonymous users is limited, accommodating only the typical usage on [https://openverse.org](https://openverse.org/). Pagination is limited in terms of the size of individual pages and the total number of works visible for a query (pagination depth).

Authenticated users are subject to the same limit of total works available for a query, but may request larger individual pages.

Increases to pagination limits on page size and total depth are available upon request (see above).

## [](https://api.openverse.org/v1/#tag/auth/operation/register)register

Register an application to access to API via OAuth2.

Upon registering, you will receive a `client_id` and `client_secret`, which you can then use to authenticate using the standard OAuth2 flow.

> ⚠️ **WARNINGS:**
> 
> 
> *   Store your `client_id` and `client_secret` because you will not be able to retrieve them later.
> *   You must keep `client_secret` confidential, as anybody with your `client_secret` can impersonate your application.

You must verify your email address by click the link sent to you in an email. Until you do that, the application will be subject to the same rate limits as an anonymous user.

##### Authorizations:

None

##### Request Body schema: 

application/json 

required

name

required string<= 150 characters 

A unique human-readable name for your application or project requiring access to the Openverse API.
description

required string<= 10000 characters 

A description of what you are trying to achieve with your project using the API. Please provide as much detail as possible!
email

required string<email><= 254 characters 

A valid email that we can reach you at if we have any questions about your use case or data consumption.

### Responses

**201**

Created

**400**

Bad Request

**401**

Unauthorized

**429**

Too Many Requests

post/v1/auth_tokens/register/

https://api.openverse.org/v1/auth_tokens/register/

### Request samples

*   Payload
*   cURL

Content type

application/json 

Copy

`{"name": "string","description": "string","email": "user@example.com"}`

### Response samples

*   201
*   400
*   401
*   429

Content type

application/json

Copy

`{"name": "My amazing project","client_id": "<Openverse API client ID>","client_secret": "<Openverse API client secret>"}`

## [](https://api.openverse.org/v1/#tag/auth/operation/token)token

Get an access token using client credentials.

To authenticate your requests to the Openverse API, you need to provide an access token as a bearer token in the `Authorization` header of your requests. This endpoint takes your client ID and secret, and issues an access token.

> **NOTE:** This endpoint only accepts data as `application/x-www-form-urlencoded`. Any other encoding will not work.

Once your access token expires, you can request another one from this endpoint.

##### Request Body schema: application/x-www-form-urlencoded

required

client_id

required string

The unique, public identifier of your application.
client_secret

required string

The secret key used to authenticate your application.
grant_type

required string (GrantTypeEnum) 

 Value:"client_credentials"

*   `client_credentials` - client_credentials

### Responses

**200**

OK

**400**

Bad Request

**401**

Unauthorized

post/v1/auth_tokens/token/

https://api.openverse.org/v1/auth_tokens/token/

### Request samples

*   cURL

Copy

# Get an access token token
curl \
  -X POST \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d 'grant_type=client_credentials&client_id=<Openverse API client ID>&client_secret=<Openverse API client secret>' \
  "https://api.openverse.org/v1/auth_tokens/token/"

### Response samples

*   200
*   400
*   401

Content type

application/json

Copy

`{"access_token": "<Openverse API token>","scope": "read write groups","expires_in": 36000,"token_type": "Bearer"}`

## [](https://api.openverse.org/v1/#tag/auth/operation/key_info)key_info

Get information about your API key.

You can use this endpoint to get information about your API key such as `requests_this_minute`, `requests_today`, and `rate_limit_model`.

> ℹ️ **NOTE:** If you get a 401 Unauthorized, it means your token is invalid (malformed, non-existent, or expired).

##### Authorizations:

_Openverse API Token_

### Responses

**200**

OK

**401**

Unauthorized

**429**

Too Many Requests

**500**

Internal Server Error

get/v1/rate_limit/

https://api.openverse.org/v1/rate_limit/

### Request samples

*   cURL

Copy

curl \
  -H "Authorization: Bearer <Openverse API token>" \
  "https://api.openverse.org/v1/rate_limit/"

### Response samples

*   200
*   401
*   429
*   500

Content type

application/json

Copy

`{"requests_this_minute": 2,"requests_today": 40,"rate_limit_model": "enhanced"}`

## [](https://api.openverse.org/v1/#tag/audio)audio

These are endpoints pertaining to audio files.

## [](https://api.openverse.org/v1/#tag/audio/operation/audio_search)audio_search

Return audio files that match the query.

This endpoint allows you to search within specific fields, or to retrieve a collection of all audio files from a specific source, creator or tag. Results are paginated on the basis of the `page` parameter. The `page_size` parameter controls the total number of pages.

Although there may be millions of relevant records, only the most relevant or the most recent several thousand records can be viewed. This is by design: the search endpoint should be used to find the top 10,000 most relevant results, not for exhaustive search or bulk download of every barely relevant result. As such, the caller should not try to access pages beyond `page_count`, or else the server will reject the query.

### Default search

The **default search** allows users to find media based on a query string. It supports a wide range of optional filters to narrow down search results according to specific needs.

By default, this endpoint performs a full-text search for the value of `q` parameter. You can search within the `creator`, `title` or `tags` fields by omitting the `q` parameter and using one of these field parameters. These results can be filtered by `source`, `excluded_source`, `license`, `license_type`, `creator`, `tags`, `title`, `filter_dead`, `extension`, `mature`, `unstable__include_sensitive_results`, `category` and `length`.

The default search results are sorted by relevance.

### Collection search

The collection search allows to retrieve a collection of media from a specific source, creator or tag. The `unstable__collection` parameter is used to specify the type of collection to retrieve.

*   `unstable__collection=tag&unstable__tag=tagName` will return the media with tag `tagName`.
*   `unstable__collection=source&source=sourceName` will return the media from source `sourceName`.
*   `unstable__collection=creator&creator=creatorName&source=sourceName` will return the media by creator `creatorName` at `sourceName`.

Collection results are sorted by the time they were added to Openverse, with the most recent additions appearing first. The filters such as `license` are not available for collections.

[Openverse Syntax Guide](https://openverse.org/search-help)

##### Authorizations:

_Openverse API Token_ None

##### query Parameters

page integer>= 1 

 Default: 1

The page of results to retrieve. This parameter is subject to limitations based on authentication and access level. For details, refer to [the authentication documentation](https://api.openverse.org/v1/#tag/auth).
page_size integer>= 1 

 Default: 20

Number of results to return per page. This parameter is subject to limitations based on authentication and access level. For details, refer to [the authentication documentation](https://api.openverse.org/v1/#tag/auth).
q string (query)  non-empty 

A query string that should not exceed 200 characters in length
source string (provider)  non-empty 

For default search, a comma separated list of data sources. When the `unstable__collection` parameter is used, this parameter only accepts a single source.

Valid values are `source_name`s from the stats endpoint: [https://api.openverse.org/v1/audio/stats/](https://api.openverse.org/v1/audio/stats/).
excluded_source string (excluded_provider)  non-empty 

A comma separated list of data sources to exclude from the search. Valid values are `source_name`s from the stats endpoint: [https://api.openverse.org/v1/audio/stats/](https://api.openverse.org/v1/audio/stats/).
tags string [ 1 .. 200 ] characters 

Search by tag only. Cannot be used with `q`. The search is fuzzy, so `tags=cat` will match any value that includes the word `cat`. If the value contains space, items that contain any of the words in the value will match. To search for several values, join them with a comma.
title string [ 1 .. 200 ] characters 

Search by title only. Cannot be used with `q`. The search is fuzzy, so `title=photo` will match any value that includes the word `photo`. If the value contains space, items that contain any of the words in the value will match. To search for several values, join them with a comma.
creator string [ 1 .. 200 ] characters 

_When `q` parameter is present, `creator` parameter is ignored._

**Creator collection** When used with `unstable__collection=creator&source=sourceName`, returns the collection of media by the specified creator. Notice that a single creator's media items can be found on several sources, but this collection only returns the items from the specified source. This is why for this collection, both the creator and the source parameters are required, and matched exactly. For a fuzzy creator search, use the default search without the `unstable__collection` parameter.

**Creator search** When used without the `unstable__collection` parameter, will search in the creator field only. The search is fuzzy, so `creator=john` will match any value that includes the word `john`. If the value contains space, items that contain any of the words in the value will match. To search for several values, join them with a comma.
unstable__collection string (collection)  non-empty 

 Enum:"tag""source""creator"

_Caution: Parameters prefixed with `unstable\_\_` are experimental and may change or be removed without notice in future updates. Use them with caution as they are not covered by our API versioning policy._

The kind of media collection to return.

Must be used with `unstable__tag`, `source` or `creator`+`source`

*   `tag` - tag
*   `source` - source
*   `creator` - creator
unstable__tag string (tag)  [ 1 .. 200 ] characters 

_Caution: Parameters prefixed with `unstable\_\_` are experimental and may change or be removed without notice in future updates. Use them with caution as they are not covered by our API versioning policy._

_Must be used with `unstable\_\_collection=tag`_

Get the collection of media with a specific tag. Returns the collection of media that has the specified tag, matching exactly and entirely.

Differences that will cause tags to not match are:

*   upper and lower case letters
*   diacritical marks
*   hyphenation
*   spacing
*   multi-word tags where the query is only one of the words in the tag
*   multi-word tags where the words are in a different order.

Examples of tags that **do not** match:

*   "Low-Quality" and "low-quality"
*   "jalapeño" and "jalapeno"
*   "Saint Pierre des Champs" and "Saint-Pierre-des-Champs"
*   "dog walking" and "dog walking" (where the latter has two spaces between the last two words, as in a typographical error)
*   "runner" and "marathon runner"
*   "exclaiming loudly" and "loudly exclaiming"

For non-exact or multi-tag matching, using the `tags` query parameter.
license string (licenses)  non-empty 

A comma separated list of licenses; available licenses include: `by`, `by-nc`, `by-nc-nd`, `by-nc-sa`, `by-nd`, `by-sa`, `cc0`, `nc-sampling+`, `pdm`, and `sampling+`.
license_type string non-empty 

A comma separated list of license types; available license types include: `all`, `all-cc`, `commercial`, and `modification`.
filter_dead boolean

 Default: true

Control whether 404 links are filtered out.
extension string non-empty 

A comma separated list of desired file extensions.
mature boolean

 Default: false

Whether to include sensitive content.
unstable__sort_by string non-empty 

 Default: "relevance"

 Enum:"relevance""indexed_on"

_Caution: Parameters prefixed with `unstable\_\_` are experimental and may change or be removed without notice in future updates. Use them with caution as they are not covered by our API versioning policy._

The field which should be the basis for sorting results.

*   `relevance` - Relevance
*   `indexed_on` - Indexing date
unstable__sort_dir string non-empty 

 Default: "desc"

 Enum:"desc""asc"

_Caution: Parameters prefixed with `unstable\_\_` are experimental and may change or be removed without notice in future updates. Use them with caution as they are not covered by our API versioning policy._

The direction of sorting. Cannot be applied when sorting by `relevance`.

*   `desc` - Descending
*   `asc` - Ascending
unstable__authority boolean (authority) 

 Default: false

_Caution: Parameters prefixed with `unstable\_\_` are experimental and may change or be removed without notice in future updates. Use them with caution as they are not covered by our API versioning policy._

If enabled, the search will add a boost to results that are from authoritative sources.
unstable__authority_boost number<double> (authority_boost)  [ 0 .. 10 ] 

 Default: 1

_Caution: Parameters prefixed with `unstable\_\_` are experimental and may change or be removed without notice in future updates. Use them with caution as they are not covered by our API versioning policy._

The boost coefficient to apply to authoritative sources, multiplied with the popularity boost.
unstable__include_sensitive_results boolean (include_sensitive_results) 

 Default: false

_Caution: Parameters prefixed with `unstable\_\_` are experimental and may change or be removed without notice in future updates. Use them with caution as they are not covered by our API versioning policy._

Whether to include results considered sensitive.
category string non-empty 

A comma separated list of categories; available categories include: `audiobook`, `music`, `news`, `podcast`, `pronunciation`, and `sound_effect`.
length string non-empty 

A comma separated list of lengths; available lengths include: `long`, `medium`, `short`, and `shortest`.
peaks boolean

 Default: false

Whether to include the waveform peaks or not

### Responses

**200**

OK

**400**

Bad Request

**401**

Unauthorized

get/v1/audio/

https://api.openverse.org/v1/audio/

### Request samples

*   cURL

Copy

# Example 0: Search for audio using single query parameter
curl \
  -H "Authorization: Bearer <Openverse API token>" \
  "https://api.openverse.org/v1/audio/?q=test"

# Example 1: Search for audio using multiple query parameters
curl \
  -H "Authorization: Bearer <Openverse API token>" \
  "https://api.openverse.org/v1/audio/?q=test&license=pdm,by&categories=illustration&page_size=1&page=1"

# Example 2: Search for audio that is an exact match of Giacomo Puccini
curl \
  -H "Authorization: Bearer <Openverse API token>" \
  "https://api.openverse.org/v1/audio/?q=%22Giacomo%20Puccini%22"

# Example 3: Search for audio related to both dog and cat
curl \
  -H "Authorization: Bearer <Openverse API token>" \
  "https://api.openverse.org/v1/audio/?q=dog+cat"

# Example 4: Search for audio related to dog or cat, but not necessarily both
curl \
  -H "Authorization: Bearer <Openverse API token>" \
  "https://api.openverse.org/v1/audio/?q=dog|cat"

# Example 5: Search for audio related to dog but won't include results related to 'pug'
curl \
  -H "Authorization: Bearer <Openverse API token>" \
  "https://api.openverse.org/v1/audio/?q=dog -pug"

# Example 6: Search for audio matching anything with the prefix 'net'
curl \
  -H "Authorization: Bearer <Openverse API token>" \
  "https://api.openverse.org/v1/audio/?q=net*"

# Example 7: Search for audio matching dogs that are either corgis or labrador
curl \
  -H "Authorization: Bearer <Openverse API token>" \
  "https://api.openverse.org/v1/audio/?q=dogs + (corgis | labrador)"

# Example 8: Search for audio matching strings close to the term theater with a difference of one character
curl \
  -H "Authorization: Bearer <Openverse API token>" \
  "https://api.openverse.org/v1/audio/?q=theatre~1"

### Response samples

*   200
*   400
*   401

Content type

application/json

Copy

 Expand all  Collapse all 

`{"result_count": 10000,"page_count": 20,"page_size": 20,"page": 1,"results": [{"id": "8624ba61-57f1-4f98-8a85-ece206c319cf","title": "Wish You Were Here","indexed_on": "2022-12-06T06:54:25Z","foreign_landing_url": "https://www.jamendo.com/track/1214935","url": "https://mp3d.jamendo.com/download/track/1214935/mp32","creator": "The.madpix.project","creator_url": "https://www.jamendo.com/artist/441585/the.madpix.project","license": "by-nc-sa","license_version": "3.0","license_url": "https://creativecommons.org/licenses/by-nc-sa/3.0/","provider": "jamendo","source": "jamendo","category": "music","genres": ["dance","electronic","house"],"filesize": 7139840,"filetype": "mp3","tags": [{"accuracy": null,"name": "vocal","unstable__provider": "jamendo"},{"accuracy": null,"name": "female","unstable__provider": "jamendo"},{"accuracy": null,"name": "speed_medium","unstable__provider": "jamendo"},{"accuracy": null,"name": "guitar","unstable__provider": "jamendo"},{"accuracy": null,"name": "strings","unstable__provider": "jamendo"},{"accuracy": null,"name": "energetic","unstable__provider": "jamendo"},{"accuracy": null,"name": "acoustic","unstable__provider": "jamendo"},{"accuracy": null,"name": "vocal","unstable__provider": "jamendo"},{"accuracy": null,"name": "voice","unstable__provider": "jamendo"},{"accuracy": null,"name": "funkyhouse","unstable__provider": "jamendo"}],"alt_files": null,"attribution": "\"Wish You Were Here\" by The.madpix.project is licensed under CC BY-NC-SA 3.0. To view a copy of this license, visit https://creativecommons.org/licenses/by-nc-sa/3.0/.","fields_matched": ["title"],"mature": false,"audio_set": {"title": "Wish You Were Here","foreign_landing_url": "https://www.jamendo.com/album/145774/wish-you-were-here","creator": "The.madpix.project","creator_url": "https://www.jamendo.com/artist/441585/the.madpix.project","url": "https://usercontent.jamendo.com?type=album&id=145774&width=200","filesize": null,"filetype": null},"duration": 270000,"bit_rate": 128000,"sample_rate": 44100,"thumbnail": "https://api.openverse.org/v1/audio/8624ba61-57f1-4f98-8a85-ece206c319cf/thumb/","detail_url": "https://api.openverse.org/v1/audio/8624ba61-57f1-4f98-8a85-ece206c319cf/","related_url": "https://api.openverse.org/v1/audio/8624ba61-57f1-4f98-8a85-ece206c319cf/related/","waveform": "https://api.openverse.org/v1/audio/8624ba61-57f1-4f98-8a85-ece206c319cf/waveform/","unstable__sensitivity": [ ]}],"warnings": [{"code": "partially invalid request parameter","message": "Some of the request parameters were bad, but we were able to process the request. Here's some information that might help you fix the problem for future requests."}]}`

## [](https://api.openverse.org/v1/#tag/audio/operation/audio_detail)audio_detail

Get the details of a specified audio track.

By using this endpoint, you can obtain info about audio files such as `id`, `title`, `indexed_on`, `foreign_landing_url`, `url`, `creator`, `creator_url`, `license`, `license_version`, `license_url`, `provider`, `source`, `category`, `genres`, `filesize`, `filetype`, `tags`, `alt_files`, `attribution`, `fields_matched`, `mature`, `audio_set`, `duration`, `bit_rate`, `sample_rate`, `thumbnail`, `detail_url`, `related_url`, `waveform`, `peaks` and `unstable__sensitivity`

##### Authorizations:

_Openverse API Token_ None

##### path Parameters

identifier

required string<uuid>

### Responses

**200**

OK

**401**

Unauthorized

**404**

Not Found

get/v1/audio/{identifier}/

https://api.openverse.org/v1/audio/{identifier}/

### Request samples

*   cURL

Copy

# Get the details of audio ID 8624ba61-57f1-4f98-8a85-ece206c319cf
curl \
  -H "Authorization: Bearer <Openverse API token>" \
  "https://api.openverse.org/v1/audio/8624ba61-57f1-4f98-8a85-ece206c319cf/"

### Response samples

*   200
*   401
*   404

Content type

application/json

Copy

 Expand all  Collapse all 

`{"id": "8624ba61-57f1-4f98-8a85-ece206c319cf","title": "Wish You Were Here","indexed_on": "2022-12-06T06:54:25Z","foreign_landing_url": "https://www.jamendo.com/track/1214935","url": "https://mp3d.jamendo.com/download/track/1214935/mp32","creator": "The.madpix.project","creator_url": "https://www.jamendo.com/artist/441585/the.madpix.project","license": "by-nc-sa","license_version": "3.0","license_url": "https://creativecommons.org/licenses/by-nc-sa/3.0/","provider": "jamendo","source": "jamendo","category": "music","genres": ["dance","electronic","house"],"filesize": 7139840,"filetype": "mp3","tags": [{"accuracy": null,"name": "vocal","unstable__provider": "jamendo"},{"accuracy": null,"name": "female","unstable__provider": "jamendo"},{"accuracy": null,"name": "speed_medium","unstable__provider": "jamendo"},{"accuracy": null,"name": "guitar","unstable__provider": "jamendo"},{"accuracy": null,"name": "strings","unstable__provider": "jamendo"},{"accuracy": null,"name": "energetic","unstable__provider": "jamendo"},{"accuracy": null,"name": "acoustic","unstable__provider": "jamendo"},{"accuracy": null,"name": "vocal","unstable__provider": "jamendo"},{"accuracy": null,"name": "voice","unstable__provider": "jamendo"},{"accuracy": null,"name": "funkyhouse","unstable__provider": "jamendo"}],"alt_files": null,"attribution": "\"Wish You Were Here\" by The.madpix.project is licensed under CC BY-NC-SA 3.0. To view a copy of this license, visit https://creativecommons.org/licenses/by-nc-sa/3.0/.","fields_matched": [ ],"mature": false,"audio_set": {"title": "Wish You Were Here","foreign_landing_url": "https://www.jamendo.com/album/145774/wish-you-were-here","creator": "The.madpix.project","creator_url": "https://www.jamendo.com/artist/441585/the.madpix.project","url": "https://usercontent.jamendo.com?type=album&id=145774&width=200","filesize": null,"filetype": null},"duration": 270000,"bit_rate": 128000,"sample_rate": 44100,"thumbnail": "https://api.openverse.org/v1/audio/8624ba61-57f1-4f98-8a85-ece206c319cf/thumb/","detail_url": "https://api.openverse.org/v1/audio/8624ba61-57f1-4f98-8a85-ece206c319cf/","related_url": "https://api.openverse.org/v1/audio/8624ba61-57f1-4f98-8a85-ece206c319cf/related/","waveform": "https://api.openverse.org/v1/audio/8624ba61-57f1-4f98-8a85-ece206c319cf/waveform/","unstable__sensitivity": [ ]}`

## [](https://api.openverse.org/v1/#tag/audio/operation/audio_related)audio_related

Get related audio files for a specified audio track.

By using this endpoint, you can get the details of related audio such as `id`, `title`, `indexed_on`, `foreign_landing_url`, `url`, `creator`, `creator_url`, `license`, `license_version`, `license_url`, `provider`, `source`, `category`, `genres`, `filesize`, `filetype`, `tags`, `alt_files`, `attribution`, `fields_matched`, `mature`, `audio_set`, `duration`, `bit_rate`, `sample_rate`, `thumbnail`, `detail_url`, `related_url`, `waveform`, `peaks` and `unstable__sensitivity`.

##### Authorizations:

_Openverse API Token_ None

##### path Parameters

identifier

required string<uuid>

### Responses

**200**

OK

**401**

Unauthorized

**404**

Not Found

get/v1/audio/{identifier}/related/

https://api.openverse.org/v1/audio/{identifier}/related/

### Request samples

*   cURL

Copy

# Get related audio files for audio ID 8624ba61-57f1-4f98-8a85-ece206c319cf
curl \
  -H "Authorization: Bearer <Openverse API token>" \
  "https://api.openverse.org/v1/audio/8624ba61-57f1-4f98-8a85-ece206c319cf/related/"

### Response samples

*   200
*   401
*   404

Content type

application/json

Copy

 Expand all  Collapse all 

`{"result_count": 10000,"page_count": 20,"page_size": 20,"page": 1,"results": [{"title": "File:Mozart - Eine kleine Nachtmusik - 1. Allegro.ogg","id": "36537842-b067-4ca0-ad67-e00ff2e06b2e","creator": "Wolfgang Amadeus Mozart","creator_url": "https://en.wikipedia.org/wiki/Wolfgang_Amadeus_Mozart","url": "https://upload.wikimedia.org/wikipedia/commons/2/24/Mozart_-_Eine_kleine_Nachtmusik_-_1._Allegro.ogg","provider": "wikimedia","source": "wikimedia","license": "by-sa","license_version": "2.0","license_url": "https://creativecommons.org/licenses/by-sa/2.0/","foreign_landing_url": "https://commons.wikimedia.org/w/index.php?curid=3536953","detail_url": "https://api.openverse.org/v1/audio/36537842-b067-4ca0-ad67-e00ff2e06b2e","related_url": "https://api.openverse.org/v1/recommendations/audio/36537842-b067-4ca0-ad67-e00ff2e06b2e","fields_matched": ["description","title"],"tags": [{"name": "exam"},{"name": "tactics"}]}],"warnings": [{"code": "partially invalid request parameter","message": "Some of the request parameters were bad, but we were able to process the request. Here's some information that might help you fix the problem for future requests."}]}`

## [](https://api.openverse.org/v1/#tag/audio/operation/audio_report)audio_report

Report an issue about a specified audio track to Openverse.

By using this endpoint, you can report an audio track if it infringes copyright, contains mature or sensitive content or some other reason.

##### Authorizations:

_Openverse API Token_ None

##### path Parameters

identifier

required string<uuid>

##### Request Body schema: 

application/json 

required

identifier

required string<uuid>

Our unique identifier for an open-licensed work.
reason

required string

 Enum:"mature""dmca""other"

The reason to report media to Openverse.

*   `mature` - mature
*   `dmca` - dmca
*   `other` - other
description string or null<= 500 characters 

The explanation on why media is being reported.

### Responses

**201**

Created

**400**

Bad Request

**401**

Unauthorized

**404**

Not Found

post/v1/audio/{identifier}/report/

https://api.openverse.org/v1/audio/{identifier}/report/

### Request samples

*   Payload
*   cURL

Content type

application/json 

Copy

`{"identifier": "14d3030c-3b61-4070-b902-342f80e99364","reason": "mature","description": "string"}`

### Response samples

*   201
*   400
*   401
*   404

Content type

application/json

Copy

`{"identifier": "8624ba61-57f1-4f98-8a85-ece206c319cf","reason": "mature","description": "This audio contains sensitive content"}`

## [](https://api.openverse.org/v1/#tag/audio/operation/audio_thumb)audio_thumb

Retrieve the scaled down and compressed thumbnail of the artwork of an audio track or its audio set.

##### Authorizations:

_Openverse API Token_ None

##### path Parameters

identifier

required string<uuid>

##### query Parameters

full_size boolean or null

 Default: false

whether to render the actual image and not a thumbnail version
compressed boolean or null

whether to compress the output image to reduce file size,defaults to opposite of `full_size`

### Responses

**200**

Thumbnail image

**401**

**404**

get/v1/audio/{identifier}/thumb/

https://api.openverse.org/v1/audio/{identifier}/thumb/

### Response samples

*   401
*   404

Content type

application/json

Copy

`{"detail": "string"}`

## [](https://api.openverse.org/v1/#tag/audio/operation/audio_waveform)audio_waveform

Get the waveform peaks for an audio track.

The peaks are provided as a list of numbers, each of these numbers being a fraction between 0 and 1. The list contains approximately 1000 numbers, although it can be slightly higher or lower, depending on the track's length.

##### Authorizations:

_Openverse API Token_ None

##### path Parameters

identifier

required string<uuid>

### Responses

**200**

OK

**401**

Unauthorized

**404**

Not Found

get/v1/audio/{identifier}/waveform/

https://api.openverse.org/v1/audio/{identifier}/waveform/

### Request samples

*   cURL

Copy

# Get the waveform of audio ID 8624ba61-57f1-4f98-8a85-ece206c319cf
curl \
  -H "Authorization: Bearer <Openverse API token>" \
  -H "Content-Type: application/json" \
  "https://api.openverse.org/v1/audio/8624ba61-57f1-4f98-8a85-ece206c319cf/waveform/"

### Response samples

*   200
*   401
*   404

Content type

application/json

Copy

 Expand all  Collapse all 

`{"len": 1083,"points": [0.61275,0.19593,0.74023,0.00089,0.00043,0.00049]}`

## [](https://api.openverse.org/v1/#tag/audio/operation/audio_stats)audio_stats

Get a list of all content sources and their respective number of audio files in the Openverse catalog.

By using this endpoint, you can obtain info about content sources such as `source_name`, `display_name`, `source_url`, `logo_url` and `media_count`.

##### Authorizations:

_Openverse API Token_ None

### Responses

**200**

OK

**401**

Unauthorized

get/v1/audio/stats/

https://api.openverse.org/v1/audio/stats/

### Request samples

*   cURL

Copy

# Get the statistics for audio sources
curl \
  -H "Authorization: Bearer <Openverse API token>" \
  "https://api.openverse.org/v1/audio/stats/"

### Response samples

*   200
*   401

Content type

application/json

Copy

 Expand all  Collapse all 

`[{"source_name": "freesound","display_name": "Freesound","source_url": "https://freesound.org/","logo_url": null,"media_count": 827}]`

## [](https://api.openverse.org/v1/#tag/audio/operation/images_thumb)images_thumb

Retrieve the scaled down and compressed thumbnail of the image.

##### Authorizations:

_Openverse API Token_ None

##### path Parameters

identifier

required string<uuid>

##### query Parameters

full_size boolean or null

 Default: false

whether to render the actual image and not a thumbnail version
compressed boolean or null

whether to compress the output image to reduce file size,defaults to opposite of `full_size`

### Responses

**200**

Thumbnail image

**401**

**404**

get/v1/images/{identifier}/thumb/

https://api.openverse.org/v1/images/{identifier}/thumb/

### Response samples

*   401
*   404

Content type

application/json

Copy

`{"detail": "string"}`

## [](https://api.openverse.org/v1/#tag/images)images

These are endpoints pertaining to images.

## [](https://api.openverse.org/v1/#tag/images/operation/images_search)images_search

Return images that match the query.

This endpoint allows you to search within specific fields, or to retrieve a collection of all images from a specific source, creator or tag. Results are paginated on the basis of the `page` parameter. The `page_size` parameter controls the total number of pages.

Although there may be millions of relevant records, only the most relevant or the most recent several thousand records can be viewed. This is by design: the search endpoint should be used to find the top 10,000 most relevant results, not for exhaustive search or bulk download of every barely relevant result. As such, the caller should not try to access pages beyond `page_count`, or else the server will reject the query.

### Default search

The **default search** allows users to find media based on a query string. It supports a wide range of optional filters to narrow down search results according to specific needs.

By default, this endpoint performs a full-text search for the value of `q` parameter. You can search within the `creator`, `title` or `tags` fields by omitting the `q` parameter and using one of these field parameters. These results can be filtered by `source`, `excluded_source`, `license`, `license_type`, `creator`, `tags`, `title`, `filter_dead`, `extension`, `mature`, `unstable__include_sensitive_results`, `category`, `aspect_ratio` and `size`.

The default search results are sorted by relevance.

### Collection search

The collection search allows to retrieve a collection of media from a specific source, creator or tag. The `unstable__collection` parameter is used to specify the type of collection to retrieve.

*   `unstable__collection=tag&unstable__tag=tagName` will return the media with tag `tagName`.
*   `unstable__collection=source&source=sourceName` will return the media from source `sourceName`.
*   `unstable__collection=creator&creator=creatorName&source=sourceName` will return the media by creator `creatorName` at `sourceName`.

Collection results are sorted by the time they were added to Openverse, with the most recent additions appearing first. The filters such as `license` are not available for collections.

[Openverse Syntax Guide](https://openverse.org/search-help)

##### Authorizations:

_Openverse API Token_ None

##### query Parameters

page integer>= 1 

 Default: 1

The page of results to retrieve. This parameter is subject to limitations based on authentication and access level. For details, refer to [the authentication documentation](https://api.openverse.org/v1/#tag/auth).
page_size integer>= 1 

 Default: 20

Number of results to return per page. This parameter is subject to limitations based on authentication and access level. For details, refer to [the authentication documentation](https://api.openverse.org/v1/#tag/auth).
q string (query)  non-empty 

A query string that should not exceed 200 characters in length
source string (provider)  non-empty 

For default search, a comma separated list of data sources. When the `unstable__collection` parameter is used, this parameter only accepts a single source.

Valid values are `source_name`s from the stats endpoint: [https://api.openverse.org/v1/images/stats/](https://api.openverse.org/v1/images/stats/).
excluded_source string (excluded_provider)  non-empty 

A comma separated list of data sources to exclude from the search. Valid values are `source_name`s from the stats endpoint: [https://api.openverse.org/v1/images/stats/](https://api.openverse.org/v1/images/stats/).
tags string [ 1 .. 200 ] characters 

Search by tag only. Cannot be used with `q`. The search is fuzzy, so `tags=cat` will match any value that includes the word `cat`. If the value contains space, items that contain any of the words in the value will match. To search for several values, join them with a comma.
title string [ 1 .. 200 ] characters 

Search by title only. Cannot be used with `q`. The search is fuzzy, so `title=photo` will match any value that includes the word `photo`. If the value contains space, items that contain any of the words in the value will match. To search for several values, join them with a comma.
creator string [ 1 .. 200 ] characters 

_When `q` parameter is present, `creator` parameter is ignored._

**Creator collection** When used with `unstable__collection=creator&source=sourceName`, returns the collection of media by the specified creator. Notice that a single creator's media items can be found on several sources, but this collection only returns the items from the specified source. This is why for this collection, both the creator and the source parameters are required, and matched exactly. For a fuzzy creator search, use the default search without the `unstable__collection` parameter.

**Creator search** When used without the `unstable__collection` parameter, will search in the creator field only. The search is fuzzy, so `creator=john` will match any value that includes the word `john`. If the value contains space, items that contain any of the words in the value will match. To search for several values, join them with a comma.
unstable__collection string (collection)  non-empty 

 Enum:"tag""source""creator"

_Caution: Parameters prefixed with `unstable\_\_` are experimental and may change or be removed without notice in future updates. Use them with caution as they are not covered by our API versioning policy._

The kind of media collection to return.

Must be used with `unstable__tag`, `source` or `creator`+`source`

*   `tag` - tag
*   `source` - source
*   `creator` - creator
unstable__tag string (tag)  [ 1 .. 200 ] characters 

_Caution: Parameters prefixed with `unstable\_\_` are experimental and may change or be removed without notice in future updates. Use them with caution as they are not covered by our API versioning policy._

_Must be used with `unstable\_\_collection=tag`_

Get the collection of media with a specific tag. Returns the collection of media that has the specified tag, matching exactly and entirely.

Differences that will cause tags to not match are:

*   upper and lower case letters
*   diacritical marks
*   hyphenation
*   spacing
*   multi-word tags where the query is only one of the words in the tag
*   multi-word tags where the words are in a different order.

Examples of tags that **do not** match:

*   "Low-Quality" and "low-quality"
*   "jalapeño" and "jalapeno"
*   "Saint Pierre des Champs" and "Saint-Pierre-des-Champs"
*   "dog walking" and "dog walking" (where the latter has two spaces between the last two words, as in a typographical error)
*   "runner" and "marathon runner"
*   "exclaiming loudly" and "loudly exclaiming"

For non-exact or multi-tag matching, using the `tags` query parameter.
license string (licenses)  non-empty 

A comma separated list of licenses; available licenses include: `by`, `by-nc`, `by-nc-nd`, `by-nc-sa`, `by-nd`, `by-sa`, `cc0`, `nc-sampling+`, `pdm`, and `sampling+`.
license_type string non-empty 

A comma separated list of license types; available license types include: `all`, `all-cc`, `commercial`, and `modification`.
filter_dead boolean

 Default: true

Control whether 404 links are filtered out.
extension string non-empty 

A comma separated list of desired file extensions.
mature boolean

 Default: false

Whether to include sensitive content.
unstable__sort_by string non-empty 

 Default: "relevance"

 Enum:"relevance""indexed_on"

_Caution: Parameters prefixed with `unstable\_\_` are experimental and may change or be removed without notice in future updates. Use them with caution as they are not covered by our API versioning policy._

The field which should be the basis for sorting results.

*   `relevance` - Relevance
*   `indexed_on` - Indexing date
unstable__sort_dir string non-empty 

 Default: "desc"

 Enum:"desc""asc"

_Caution: Parameters prefixed with `unstable\_\_` are experimental and may change or be removed without notice in future updates. Use them with caution as they are not covered by our API versioning policy._

The direction of sorting. Cannot be applied when sorting by `relevance`.

*   `desc` - Descending
*   `asc` - Ascending
unstable__authority boolean (authority) 

 Default: false

_Caution: Parameters prefixed with `unstable\_\_` are experimental and may change or be removed without notice in future updates. Use them with caution as they are not covered by our API versioning policy._

If enabled, the search will add a boost to results that are from authoritative sources.
unstable__authority_boost number<double> (authority_boost)  [ 0 .. 10 ] 

 Default: 1

_Caution: Parameters prefixed with `unstable\_\_` are experimental and may change or be removed without notice in future updates. Use them with caution as they are not covered by our API versioning policy._

The boost coefficient to apply to authoritative sources, multiplied with the popularity boost.
unstable__include_sensitive_results boolean (include_sensitive_results) 

 Default: false

_Caution: Parameters prefixed with `unstable\_\_` are experimental and may change or be removed without notice in future updates. Use them with caution as they are not covered by our API versioning policy._

Whether to include results considered sensitive.
category string non-empty 

A comma separated list of categories; available categories include: `digitized_artwork`, `illustration`, and `photograph`.
aspect_ratio string non-empty 

A comma separated list of aspect ratios; available aspect ratios include: `square`, `tall`, and `wide`.
size string non-empty 

A comma separated list of image sizes; available image sizes include: `large`, `medium`, and `small`.

### Responses

**200**

OK

**400**

Bad Request

**401**

Unauthorized

get/v1/images/

https://api.openverse.org/v1/images/

### Request samples

*   cURL

Copy

# Example 0: Search for images using single query parameter
curl \
  -H "Authorization: Bearer <Openverse API token>" \
  "https://api.openverse.org/v1/images/?q=test"

# Example 1: Search for images using multiple query parameters
curl \
  -H "Authorization: Bearer <Openverse API token>" \
  "https://api.openverse.org/v1/images/?q=test&license=pdm,by&categories=illustration&page_size=1&page=1"

# Example 2: Search for images that are an exact match of Claude Monet
curl \
  -H "Authorization: Bearer <Openverse API token>" \
  "https://api.openverse.org/v1/images/?q=%22Claude%20Monet%22"

# Example 3: Search for images related to both dog and cat
curl \
  -H "Authorization: Bearer <Openverse API token>" \
  "https://api.openverse.org/v1/images/?q=dog+cat"

# Example 4: Search for images related to dog or cat, but not necessarily both
curl \
  -H "Authorization: Bearer <Openverse API token>" \
  "https://api.openverse.org/v1/images/?q=dog|cat"

# Example 5: Search for images related to dog but won't include results related to 'pug'
curl \
  -H "Authorization: Bearer <Openverse API token>" \
  "https://api.openverse.org/v1/images/?q=dog -pug"

# Example 6: Search for images matching anything with the prefix ‘net’
curl \
  -H "Authorization: Bearer <Openverse API token>" \
  "https://api.openverse.org/v1/images/?q=net*"

# Example 7: Search for images matching dogs that are either corgis or labrador
curl \
  -H "Authorization: Bearer <Openverse API token>" \
  "https://api.openverse.org/v1/images/?q=dogs + (corgis | labrador)"

# Example 8: Search for images matching strings close to the term theaterwith a difference of one character
curl \
  -H "Authorization: Bearer <Openverse API token>" \
  "https://api.openverse.org/v1/images/?q=theatre~1"

### Response samples

*   200
*   400
*   401

Content type

application/json

Copy

 Expand all  Collapse all 

`{"result_count": 10000,"page_count": 20,"page_size": 20,"page": 1,"results": [{"id": "4bc43a04-ef46-4544-a0c1-63c63f56e276","title": "Tree Bark Photo","indexed_on": "2022-08-27T17:39:48Z","foreign_landing_url": "https://stocksnap.io/photo/XNVBVXO3B7","url": "https://cdn.stocksnap.io/img-thumbs/960w/XNVBVXO3B7.jpg","creator": "Tim Sullivan","creator_url": "https://www.secretagencygroup.com","license": "cc0","license_version": "1.0","license_url": "https://creativecommons.org/publicdomain/zero/1.0/","provider": "stocksnap","source": "stocksnap","category": "photograph","filesize": 896128,"filetype": "jpg","tags": [{"accuracy": null,"name": "tree","unstable__provider": "stocksnap"},{"accuracy": null,"name": "bark","unstable__provider": "stocksnap"},{"accuracy": null,"name": "texture","unstable__provider": "stocksnap"},{"accuracy": null,"name": "wood","unstable__provider": "stocksnap"},{"accuracy": null,"name": "nature","unstable__provider": "stocksnap"},{"accuracy": null,"name": "pattern","unstable__provider": "stocksnap"},{"accuracy": null,"name": "rough","unstable__provider": "stocksnap"},{"accuracy": null,"name": "surface","unstable__provider": "stocksnap"},{"accuracy": null,"name": "brown","unstable__provider": "stocksnap"},{"accuracy": null,"name": "old","unstable__provider": "stocksnap"},{"accuracy": null,"name": "background","unstable__provider": "stocksnap"},{"accuracy": null,"name": "trunk","unstable__provider": "stocksnap"},{"accuracy": null,"name": "natural","unstable__provider": "stocksnap"},{"accuracy": null,"name": "forest","unstable__provider": "stocksnap"},{"accuracy": null,"name": "detail","unstable__provider": "stocksnap"},{"accuracy": null,"name": "lumber","unstable__provider": "stocksnap"},{"accuracy": null,"name": "weathered","unstable__provider": "stocksnap"},{"accuracy": null,"name": "timber","unstable__provider": "stocksnap"},{"accuracy": null,"name": "stump","unstable__provider": "stocksnap"},{"accuracy": null,"name": "closeup","unstable__provider": "stocksnap"},{"accuracy": null,"name": "root","unstable__provider": "stocksnap"},{"accuracy": 0.95,"name": "tree","unstable__provider": "machine_example"},{"accuracy": 0.9,"name": "bark","unstable__provider": "machine_example"},{"accuracy": 0.98,"name": "plant","unstable__provider": "machine_example"}],"attribution": "\"Tree Bark Photo\" by Tim Sullivan is marked with CC0 1.0. To view the terms, visit https://creativecommons.org/publicdomain/zero/1.0/.","fields_matched": ["title"],"mature": false,"height": 4016,"width": 6016,"thumbnail": "https://api.openverse.org/v1/images/4bc43a04-ef46-4544-a0c1-63c63f56e276/thumb/","detail_url": "https://api.openverse.org/v1/images/4bc43a04-ef46-4544-a0c1-63c63f56e276/","related_url": "https://api.openverse.org/v1/images/4bc43a04-ef46-4544-a0c1-63c63f56e276/related/","unstable__sensitivity": [ ]}],"warnings": [{"code": "partially invalid request parameter","message": "Some of the request parameters were bad, but we were able to process the request. Here's some information that might help you fix the problem for future requests."}]}`

## [](https://api.openverse.org/v1/#tag/images/operation/images_detail)images_detail

Get the details of a specified image.

By using this endpoint, you can obtain info about images such as `id`, `title`, `indexed_on`, `foreign_landing_url`, `url`, `creator`, `creator_url`, `license`, `license_version`, `license_url`, `provider`, `source`, `category`, `filesize`, `filetype`, `tags`, `attribution`, `fields_matched`, `mature`, `height`, `width`, `thumbnail`, `detail_url`, `related_url` and `unstable__sensitivity`

##### Authorizations:

_Openverse API Token_ None

##### path Parameters

identifier

required string<uuid>

### Responses

**200**

OK

**401**

Unauthorized

**404**

Not Found

get/v1/images/{identifier}/

https://api.openverse.org/v1/images/{identifier}/

### Request samples

*   cURL

Copy

# Get the details of image ID 4bc43a04-ef46-4544-a0c1-63c63f56e276
curl \
  -H "Authorization: Bearer <Openverse API token>" \
  "https://api.openverse.org/v1/images/4bc43a04-ef46-4544-a0c1-63c63f56e276/"

### Response samples

*   200
*   401
*   404

Content type

application/json

Copy

 Expand all  Collapse all 

`{"id": "4bc43a04-ef46-4544-a0c1-63c63f56e276","title": "Tree Bark Photo","indexed_on": "2022-08-27T17:39:48Z","foreign_landing_url": "https://stocksnap.io/photo/XNVBVXO3B7","url": "https://cdn.stocksnap.io/img-thumbs/960w/XNVBVXO3B7.jpg","creator": "Tim Sullivan","creator_url": "https://www.secretagencygroup.com","license": "cc0","license_version": "1.0","license_url": "https://creativecommons.org/publicdomain/zero/1.0/","provider": "stocksnap","source": "stocksnap","category": "photograph","filesize": 896128,"filetype": "jpg","tags": [{"accuracy": null,"name": "tree","unstable__provider": "stocksnap"},{"accuracy": null,"name": "bark","unstable__provider": "stocksnap"},{"accuracy": null,"name": "texture","unstable__provider": "stocksnap"},{"accuracy": null,"name": "wood","unstable__provider": "stocksnap"},{"accuracy": null,"name": "nature","unstable__provider": "stocksnap"},{"accuracy": null,"name": "pattern","unstable__provider": "stocksnap"},{"accuracy": null,"name": "rough","unstable__provider": "stocksnap"},{"accuracy": null,"name": "surface","unstable__provider": "stocksnap"},{"accuracy": null,"name": "brown","unstable__provider": "stocksnap"},{"accuracy": null,"name": "old","unstable__provider": "stocksnap"},{"accuracy": null,"name": "background","unstable__provider": "stocksnap"},{"accuracy": null,"name": "trunk","unstable__provider": "stocksnap"},{"accuracy": null,"name": "natural","unstable__provider": "stocksnap"},{"accuracy": null,"name": "forest","unstable__provider": "stocksnap"},{"accuracy": null,"name": "detail","unstable__provider": "stocksnap"},{"accuracy": null,"name": "lumber","unstable__provider": "stocksnap"},{"accuracy": null,"name": "weathered","unstable__provider": "stocksnap"},{"accuracy": null,"name": "timber","unstable__provider": "stocksnap"},{"accuracy": null,"name": "stump","unstable__provider": "stocksnap"},{"accuracy": null,"name": "closeup","unstable__provider": "stocksnap"},{"accuracy": null,"name": "root","unstable__provider": "stocksnap"},{"accuracy": 0.95,"name": "tree","unstable__provider": "machine_example"},{"accuracy": 0.9,"name": "bark","unstable__provider": "machine_example"},{"accuracy": 0.98,"name": "plant","unstable__provider": "machine_example"}],"attribution": "\"Tree Bark Photo\" by Tim Sullivan is marked with CC0 1.0. To view the terms, visit https://creativecommons.org/publicdomain/zero/1.0/.","fields_matched": [ ],"mature": false,"height": 4016,"width": 6016,"thumbnail": "https://api.openverse.org/v1/images/4bc43a04-ef46-4544-a0c1-63c63f56e276/thumb/","detail_url": "https://api.openverse.org/v1/images/4bc43a04-ef46-4544-a0c1-63c63f56e276/","related_url": "https://api.openverse.org/v1/images/4bc43a04-ef46-4544-a0c1-63c63f56e276/related/","unstable__sensitivity": [ ]}`

## [](https://api.openverse.org/v1/#tag/images/operation/images_related)images_related

Get related images for a specified image.

By using this endpoint, you can get the details of related images such as `id`, `title`, `indexed_on`, `foreign_landing_url`, `url`, `creator`, `creator_url`, `license`, `license_version`, `license_url`, `provider`, `source`, `category`, `filesize`, `filetype`, `tags`, `attribution`, `fields_matched`, `mature`, `height`, `width`, `thumbnail`, `detail_url`, `related_url` and `unstable__sensitivity`.

##### Authorizations:

_Openverse API Token_ None

##### path Parameters

identifier

required string<uuid>

### Responses

**200**

OK

**401**

Unauthorized

**404**

Not Found

get/v1/images/{identifier}/related/

https://api.openverse.org/v1/images/{identifier}/related/

### Request samples

*   cURL

Copy

# Get related images for image ID 4bc43a04-ef46-4544-a0c1-63c63f56e276
curl \
  -H "Authorization: Bearer <Openverse API token>" \
  "https://api.openverse.org/v1/images/4bc43a04-ef46-4544-a0c1-63c63f56e276/related/"

### Response samples

*   200
*   401
*   404

Content type

application/json

Copy

 Expand all  Collapse all 

`{"result_count": 10000,"page_count": 20,"page_size": 20,"page": 1,"results": [{"title": "exam tactics","id": "610756ec-ae31-4d5e-8f03-8cc52f31b71d","creator": "Sean MacEntee","creator_url": "https://www.flickr.com/photos/18090920@N07","tags": [{"name": "exam"},{"name": "tactics"}],"url": "https://live.staticflickr.com/4065/4459771899_07595dc42e.jpg","thumbnail": "https://api.openverse.org/v1/thumbs/610756ec-ae31-4d5e-8f03-8cc52f31b71d","provider": "flickr","source": "flickr","license": "by","license_version": "2.0","license_url": "https://creativecommons.org/licenses/by/2.0/","foreign_landing_url": "https://www.flickr.com/photos/18090920@N07/4459771899","detail_url": "https://api.openverse.org/v1/images/610756ec-ae31-4d5e-8f03-8cc52f31b71d","related_url": "https://api.openverse.org/v1/recommendations/images/610756ec-ae31-4d5e-8f03-8cc52f31b71d"}],"warnings": [{"code": "partially invalid request parameter","message": "Some of the request parameters were bad, but we were able to process the request. Here's some information that might help you fix the problem for future requests."}]}`

## [](https://api.openverse.org/v1/#tag/images/operation/images_report)images_report

Report an issue about a specified image to Openverse.

By using this endpoint, you can report an image if it infringes copyright, contains mature or sensitive content or some other reason.

##### Authorizations:

_Openverse API Token_ None

##### path Parameters

identifier

required string<uuid>

##### Request Body schema: 

application/json 

required

identifier

required string<uuid>

Our unique identifier for an open-licensed work.
reason

required string

 Enum:"mature""dmca""other"

The reason to report media to Openverse.

*   `mature` - mature
*   `dmca` - dmca
*   `other` - other
description string or null<= 500 characters 

The explanation on why media is being reported.

### Responses

**201**

Created

**400**

Bad Request

**401**

Unauthorized

**404**

Not Found

post/v1/images/{identifier}/report/

https://api.openverse.org/v1/images/{identifier}/report/

### Request samples

*   Payload
*   cURL

Content type

application/json 

Copy

`{"identifier": "14d3030c-3b61-4070-b902-342f80e99364","reason": "mature","description": "string"}`

### Response samples

*   201
*   400
*   401
*   404

Content type

application/json

Copy

`{"identifier": "4bc43a04-ef46-4544-a0c1-63c63f56e276","reason": "mature","description": "Image contains sensitive content"}`

## [](https://api.openverse.org/v1/#tag/images/operation/images_oembed)images_oembed

Retrieve the structured data for a specified image URL as per the [oEmbed spec](https://oembed.com/).

This info can be used to embed the image on the consumer's website. Only JSON format is supported.

##### Authorizations:

_Openverse API Token_ None

##### query Parameters

url

required string<uri> non-empty 

The link to an image present in Openverse.

### Responses

**200**

OK

**400**

Bad Request

**401**

Unauthorized

**404**

Not Found

get/v1/images/oembed/

https://api.openverse.org/v1/images/oembed/

### Request samples

*   cURL

Copy

# Retrieve embedded content from an image's URL
curl \
  -H "Authorization: Bearer <Openverse API token>" \
  "https://api.openverse.org/v1/images/oembed/?url=https://wordpress.org/openverse/photos/4bc43a04-ef46-4544-a0c1-63c63f56e276"

### Response samples

*   200
*   400
*   401
*   404

Content type

application/json

Copy

`{"version": "1.0","type": "photo","width": 6016,"height": 4016,"title": "Tree Bark Photo","author_name": "Tim Sullivan","author_url": "https://www.secretagencygroup.com","license_url": "https://creativecommons.org/publicdomain/zero/1.0/"}`

## [](https://api.openverse.org/v1/#tag/images/operation/images_stats)images_stats

Get a list of all content sources and their respective number of images in the Openverse catalog.

By using this endpoint, you can obtain info about content sources such as `source_name`, `display_name`, `source_url`, `logo_url` and `media_count`.

##### Authorizations:

_Openverse API Token_ None

### Responses

**200**

OK

**401**

Unauthorized

get/v1/images/stats/

https://api.openverse.org/v1/images/stats/

### Request samples

*   cURL

Copy

# Get the statistics for image sources
curl \
  -H "Authorization: Bearer <Openverse API token>" \
  "https://api.openverse.org/v1/images/stats/"

### Response samples

*   200
*   401

Content type

application/json

Copy

 Expand all  Collapse all 

`[{"source_name": "flickr","display_name": "Flickr","source_url": "https://www.flickr.com","logo_url": null,"media_count": 2500}]`
