[![Unsplash Help Center](https://downloads.intercomcdn.com/i/o/118519/ddfeac07590ae764956095e7/4e16b83b84b7649bece46ae25a166d47.png)](/en/)

# Guideline: Triggering a Download

U

Written by Unsplash Dev

From the [API Guidelines](https://help.unsplash.com/api-guidelines/unsplash-api-guidelines):  
​  
​**When your application performs something similar to a download (like when a user chooses the image to include in a blog post, set as a header, etc.), you must send a request to the download endpoint returned under the** `photo.links.download_location` **property.**

Downloads and views are one of the main motivations for many Unsplash contributors. By opening up the Unsplash API to 3rd party applications their photography is seen and used by more users which inspires them to contribute more, other contributors to join, and an even better library for you and your community of creatives.

Every photo has a unique download link that exists on the `photo.links.download_location` field included with all photos.

```
{  
  "id": "LBI7cgq3pbM",  
  "width": 5245,  
  "height": 3497,  
  "color": "#60544D",  
  "urls": { ... },  
  "user": { ... },  
  "links": {  
    "self": "https://api.unsplash.com/photos/LBI7cgq3pbM",  
    "html": "https://unsplash.com/photos/LBI7cgq3pbM",  
    "download": "https://unsplash.com/photos/LBI7cgq3pbM/download", // don't use this property  
    "download_location": "https://api.unsplash.com/photos/LBI7cgq3pbM/download?ixid=MnwxMTc4ODl8MHwxfHNlYXJjaHwxfHxwdXBweXxlbnwwfHx8fDE2MTc3NTA2MTM" // use this one ;)  
  }  
}
```

When calling the `download_location` endpoint, be sure to [authorize](https://unsplash.com/documentation#authorization) the call (either include your `client_id` or the user’s bearer token), otherwise you will get a `401`. Be sure to include any query parameters included in the URL (like the `ixid`).

An action “similar to a download of an image” can be thought of as an action where a user does something with the photo, usually inserting or setting it somewhere.

Some examples from our own API applications:

* on [Unsplash Wallpapers](https://unsplash.com/wallpaper#mac-app), when a user sets the photo as their wallpaper we trigger the download endpoint for the photo
* on [Unsplash for Google Slides](https://chrome.google.com/webstore/detail/unsplash-photos/aldghkomejnfjohekcnedoeecfbhacjm?hl=en), when a user chooses a photo to insert into their presentation we trigger the download endpoint for the photo

Some examples from 3rd party applications:

* on [Craft by Invision](https://www.invisionapp.com/craft), when a user inserts a photo into Sketch or Photoshop, the download endpoint is triggered
* on [Ghost](https://ghost.org/), when a user inserts a photo into a blog post, the download endpoint is triggered
* on [Trello](https://trello.com/), when a user chooses a photo as a background for their board, the download endpoint is triggered
* on [Over](https://madewithover.com/), when a user selects a photo to remix, the download endpoint is triggered

We’ve found that it’s best to trigger the endpoint asynchronously to make sure that it doesn’t slow down your user’s interactions.

**Note:** this is purely an event endpoint used to increment the number of downloads a photo has. You can think of it very similarly to the pageview event in Google Analytics—where you’re incrementing a counter on the backend. The `download_location` is not to be used to embed the photo (use the `photo.urls.*` properties instead) or to direct the user downloading the photo to (use the `photo.urls.full` for that instead).

Some example pseudo-ish code using the `unsplash-js` library:

```
// user searches for 'dogs' and chooses to use the first result  
unsplash.search.photos({ query: 'dogs' }).then(result => {  
 if (result.type === 'success') {  
 const firstPhoto = result.response.results[0];  
    
    // do something with the image URLs, like embedding it in a hypothetical post  
    $('img.post').attr('src', firstPhoto['urls']['regular']);  
    
    // trigger a download event  
 unsplash.photos.trackDownload({ downloadLocation: photo.links.download_location, });  
  });
```
