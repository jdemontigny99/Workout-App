package com.example.myapplication

import android.net.Uri
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.viewpager2.widget.ViewPager2

class ImageViewerActivity : AppCompatActivity() {

    private lateinit var viewPager: ViewPager2
    private lateinit var imageUris: List<Uri>

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_image_viewer)

        viewPager = findViewById(R.id.viewPager)

        // Get the image URIs from the intent
        val imageUriStrings = intent.getStringArrayListExtra("imageUris")
        imageUris = imageUriStrings?.map { Uri.parse(it) } ?: emptyList()

        // Set up the adapter
        viewPager.adapter = ImagePagerAdapter(imageUris)
    }
}

