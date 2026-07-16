import os
import zipfile
import sys

def zip_dir(directory, zip_filename):
    with zipfile.ZipFile(zip_filename, 'w', zipfile.ZIP_DEFLATED) as zipf:
        for root, dirs, files in os.walk(directory):
            for file in files:
                file_path = os.path.join(root, file)
                # Create archive name with forward slashes explicitly
                arcname = os.path.relpath(file_path, directory).replace('\\', '/')
                zipf.write(file_path, arcname)

if __name__ == '__main__':
    if len(sys.argv) != 3:
        print("Usage: build_zip.py <directory> <zip_file>")
        sys.exit(1)
    
    zip_dir(sys.argv[1], sys.argv[2])
