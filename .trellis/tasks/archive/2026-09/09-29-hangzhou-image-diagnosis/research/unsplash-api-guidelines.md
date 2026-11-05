[![Unsplash Help Center](https://downloads.intercomcdn.com/i/o/118519/ddfeac07590ae764956095e7/4e16b83b84b7649bece46ae25a166d47.png)](/en/)

# Unsplash API Guidelines

The official technical guidelines for integrating the Unsplash API into your application.

U

Written by Unsplash Dev

Table of contents

Thanks for your interest in the Unsplash API.

To save time and increase your chances of having your application approved, please make sure that your application submission meets the guidelines.

If your submission does not clearly meet all of the guidelines, it will likely be rejected for a rate limit increase until you provide clear examples of all of the guidelines being met.

## Technical Guidelines

1. All API uses must use the hotlinked image URLs returned by the API under the `photo.urls`  properties. This applies to all uses of the image and not just search results. [More info & examples →](https://help.unsplash.com/api-guidelines/guideline-hotlinking-images)
2. When your application performs something similar to a download (like when a user chooses the image to include in a blog post, set as a header, etc.), you must send a request to the download endpoint returned under the `photo.links.download_location`  property. [More info & examples →](https://help.unsplash.com/api-guidelines/guideline-triggering-a-download)
3. When displaying a photo from Unsplash, your application must attribute Unsplash, the Unsplash photographer, and contain a link back to their Unsplash profile. All links back to Unsplash should use utm parameters in the `?utm_source=your_app_name&utm_medium=referral` . [More info & examples →](https://help.unsplash.com/api-guidelines/guideline-attribution)
4. Your application’s `Access Key` and `Secret Key`  must remain confidential. This may require using a proxy if accessing the API client-side.

## Usage Guidelines

1. You cannot use the Unsplash name directly in your application name and you cannot use the Unsplash logo as an app icon.
2. You cannot use the API to sell unaltered Unsplash photos directly or indirectly (prints, on products, etc.)
3. You cannot replicate the core user experience of Unsplash (unofficial clients, wallpaper applications, etc.). [More info & examples →](https://help.unsplash.com/api-guidelines/guideline-replicating-unsplash)
4. The API is to be used for non-automated, high-quality, and authentic experiences. [More info & examples →](https://help.unsplash.com/api-guidelines/guideline-high-quality-authentic-experiences)
5. Do not abuse the APIs. Too many requests too quickly will get your access turned off.
6. Applications should not require users to register for a developer account with the Unsplash API to use your application. If needed, build a proxy that signs requests on behalf of your users, allowing them to all share a single API key, or reach out to [our team](mailto:api@unsplash.com) for an OAuth solution.

We recommend taking a look at each of the accompanying articles as they provide visual and code examples. If after reading those you have any questions, feel free to [reach out to us](mailto:api@unsplash.com).

Happy building! 👏

Table of contents
